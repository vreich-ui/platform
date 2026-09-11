import dns from 'node:dns/promises';
import { isIP } from 'node:net';

import { getDirectArtifactUploadMaxBytes, saveArtifactBytes, type SaveArtifactBytesResult } from './artifact-upload.js';
import { type ArtifactRequestOwnerType } from './artifact-index.js';
import { type ArtifactKind } from './artifacts.js';
import { sha256Hex } from './crypto.js';

export type SaveArtifactFromUrlInput = {
  requestId: string;
  artifactKind: ArtifactKind;
  contentType: string;
  sourceUrl: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  filename?: string;
  label?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  event?: unknown;
  /**
   * W1 T1.3: the CMS object that owns this request id. Forwarded verbatim to
   * `saveArtifactBytes`, which registers the pointer once the bytes are
   * stored. Omitting it is today's behaviour — no pointer is written.
   */
  owner?: { object_type: ArtifactRequestOwnerType; object_id: string };
};

export type SaveArtifactFromUrlResult = SaveArtifactBytesResult & {
  sourceUrl: string;
  fetchedBytes?: number;
  maxBytes?: number;
};

const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

/**
 * Internal utilities that can be mocked in tests.
 */
export const _ingestInternal = {
  dnsLookup: async (hostname: string) => {
    return await dns.lookup(hostname, { all: true });
  },
  fetch: async (url: string, init?: RequestInit) => {
    return await fetch(url, init);
  },
};

/**
 * Validates that an IP address is a public, non-loopback, non-private address.
 */
const isSafeIp = (ip: string): boolean => {
  const version = isIP(ip);

  // Handle IPv4-mapped IPv6 addresses (::ffff:1.2.3.4)
  if (version === 6 && ip.toLowerCase().startsWith('::ffff:')) {
    const lastPart = ip.split(':').pop();
    if (lastPart && isIP(lastPart) === 4) {
      return isSafeIp(lastPart);
    }
  }

  if (version === 4) {
    const parts = ip.split('.').map(Number);
    // 0.0.0.0/8 - "This" network
    if (parts[0] === 0) return false;
    // 10.0.0.0/8 - Private-Use
    if (parts[0] === 10) return false;
    // 100.64.0.0/10 - Shared Address Space
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false;
    // 127.0.0.0/8 - Loopback
    if (parts[0] === 127) return false;
    // 169.254.0.0/16 - Link-Local
    if (parts[0] === 169 && parts[1] === 254) return false;
    // 172.16.0.0/12 - Private-Use
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    // 192.0.0.0/24 - IETF Protocol Assignments
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return false;
    // 192.0.2.0/24 - Documentation (TEST-NET-1)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return false;
    // 192.168.0.0/16 - Private-Use
    if (parts[0] === 192 && parts[1] === 168) return false;
    // 198.18.0.0/15 - Benchmarking
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return false;
    // 198.51.100.0/24 - Documentation (TEST-NET-2)
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return false;
    // 203.0.113.0/24 - Documentation (TEST-NET-3)
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return false;
    // 224.0.0.0/4 - Multicast
    if (parts[0] >= 224 && parts[0] <= 239) return false;
    // 240.0.0.0/4 - Reserved
    if (parts[0] >= 240) return false;
    // 255.255.255.255/32 - Limited Broadcast
    if (ip === '255.255.255.255') return false;

    return true;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();
    // Unspecified: ::
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return false;
    // Loopback: ::1
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return false;
    // Unique Local: fc00::/7
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    // Link-Local: fe80::/10
    if (/^fe[89ab]/i.test(normalized)) return false;
    // Multicast: ff00::/8
    if (normalized.startsWith('ff')) return false;

    return true;
  }

  return false;
};

const isHostnameAllowed = (hostname: string): boolean => {
  const envValue =
    (globalThis as unknown as { Netlify?: { env?: { get?: (k: string) => string | undefined } } }).Netlify?.env?.get?.(
      'ARTIFACT_URL_INGEST_ALLOWED_HOSTS'
    ) || process.env.ARTIFACT_URL_INGEST_ALLOWED_HOSTS;
  if (!envValue) return true;

  const allowed = envValue
    .split(',')
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return true;

  const lowerHost = hostname.toLowerCase();
  for (const entry of allowed) {
    if (entry.startsWith('.')) {
      if (lowerHost.endsWith(entry) || lowerHost === entry.slice(1)) return true;
    } else if (lowerHost === entry) {
      return true;
    }
  }

  return false;
};

const validateUrlSafety = async (url: URL) => {
  if (url.protocol !== 'https:') {
    throw new Error('Only https: URLs are allowed for artifact ingestion.');
  }

  if (url.username || url.password) {
    throw new Error('URLs with credentials are not allowed for artifact ingestion.');
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new Error('Invalid source URL: missing hostname.');
  }

  if (!isHostnameAllowed(hostname)) {
    throw new Error(`Hostname "${hostname}" is not in the allowed list for artifact ingestion.`);
  }

  // If it's already an IP, validate it.
  if (isIP(hostname)) {
    if (!isSafeIp(hostname)) {
      throw new Error(`Forbidden source IP address: ${hostname}`);
    }
    return;
  }

  // Resolve hostname and validate all returned IPs.
  try {
    const result = await _ingestInternal.dnsLookup(hostname);
    if (!result.length) {
      throw new Error(`Could not resolve hostname: ${hostname}`);
    }
    for (const entry of result) {
      if (!isSafeIp(entry.address)) {
        throw new Error(`Forbidden source IP address resolved for ${hostname}: ${entry.address}`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden source IP')) {
      throw error;
    }
    throw new Error(
      `Failed to resolve hostname ${hostname}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const fetchArtifactBytesFromUrl = async (
  input: Pick<SaveArtifactFromUrlInput, 'sourceUrl' | 'expectedSizeBytes' | 'expectedSha256'>
): Promise<Buffer> => {
  let currentUrlString = input.sourceUrl;
  let redirects = 0;
  const maxBytes = getDirectArtifactUploadMaxBytes();

  while (true) {
    const url = new URL(currentUrlString);
    await validateUrlSafety(url);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await _ingestInternal.fetch(currentUrlString, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Netlify-Artifact-Ingest/1.0',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect status ${response.status} received without Location header.`);
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Maximum redirect limit of ${MAX_REDIRECTS} exceeded.`);
        }
        currentUrlString = new URL(location, currentUrlString).toString();
        redirects++;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch artifact from URL: HTTP ${response.status} ${response.statusText}`);
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (Number.isInteger(contentLength) && contentLength > maxBytes) {
          throw new Error(`Artifact size from Content-Length (${contentLength}) exceeds limit of ${maxBytes} bytes.`);
        }
      }

      const arrayBuffer = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);

      if (bytes.length > maxBytes) {
        throw new Error(`Fetched artifact size (${bytes.length}) exceeds limit of ${maxBytes} bytes.`);
      }

      if (bytes.length !== input.expectedSizeBytes) {
        throw new Error(
          `Artifact size mismatch: expected ${input.expectedSizeBytes} bytes, received ${bytes.length} bytes.`
        );
      }

      const actualSha256 = sha256Hex(bytes);
      if (actualSha256 !== input.expectedSha256.toLowerCase()) {
        throw new Error(`Artifact sha256 mismatch: expected ${input.expectedSha256}, received ${actualSha256}.`);
      }

      return bytes;
    } finally {
      clearTimeout(timeoutId);
    }
  }
};

export const saveArtifactFromUrl = async (input: SaveArtifactFromUrlInput): Promise<SaveArtifactFromUrlResult> => {
  const maxBytes = getDirectArtifactUploadMaxBytes();
  try {
    const bytes = await fetchArtifactBytesFromUrl({
      sourceUrl: input.sourceUrl,
      expectedSizeBytes: input.expectedSizeBytes,
      expectedSha256: input.expectedSha256,
    });

    const saveResult = await saveArtifactBytes({
      requestId: input.requestId,
      artifactKind: input.artifactKind,
      contentType: input.contentType,
      expectedSizeBytes: input.expectedSizeBytes,
      expectedSha256: input.expectedSha256,
      filename: input.filename,
      label: input.label,
      tags: input.tags,
      bytes: bytes,
      metadata: input.metadata,
      event: input.event,
      owner: input.owner,
      ownerRegisteredBy: 'create_artifact_from_url',
    });

    return {
      ...saveResult,
      sourceUrl: input.sourceUrl,
      fetchedBytes: bytes.length,
      maxBytes,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: (error as { statusCode?: number }).statusCode || 400,
      error: error instanceof Error ? error.message : String(error),
      sourceUrl: input.sourceUrl,
      maxBytes,
    };
  }
};
