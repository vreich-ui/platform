import assert from 'node:assert/strict';
import test from 'node:test';

import { handler as verifyHandler } from '../../netlify/functions/verify-article-images.js';
import { createAdminArtifactPreviewLoader, getAdminBlobImageEndpoint } from '../../packages/core/lib/admin/artifact-preview.js';

const publishSecret = 'verify-images-matching-test-secret';

type VerifyResponseBody = {
  verified: boolean;
  inconclusive?: boolean;
  pageStatus?: number;
  errors?: string[];
  commit?: string;
  deployAware?: boolean;
  deployReady?: boolean;
  deployNote?: string;
  deploy?: { deployStatus?: string; commit?: string };
  images: Array<{
    expected: string;
    present: boolean;
    ok: boolean;
    matchedUrl?: string;
    matchedBy?: string;
    error?: string;
  }>;
  expectedDocuments?: string[];
  documents?: Array<{
    expected: string;
    present: boolean;
    ok: boolean;
    status?: number;
    contentType?: string;
    matchedUrl?: string;
    matchedBy?: string;
    error?: string;
  }>;
};

const callVerify = async (
  expectedImages: string[],
  routes: Record<string, () => Response>,
  extra: Record<string, unknown> = {}
): Promise<VerifyResponseBody> => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [route, respond] of Object.entries(routes)) {
      if (url === route) return respond();
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    const response = await verifyHandler({
      httpMethod: 'POST',
      headers: { 'x-publish-key': publishSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/learn/my-article', expectedImages, ...extra }),
    });
    return JSON.parse(response.body) as VerifyResponseBody;
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const pageHtml = (imgTags: string) => `<!doctype html><html><body><article>${imgTags}</article></body></html>`;
const pngResponse = () => new Response('png-bytes', { status: 200, headers: { 'content-type': 'image/png' } });
const webpResponse = () => new Response('webp-bytes', { status: 200, headers: { 'content-type': 'image/webp' } });

test('verify matches Astro-hashed build URLs by filename stem for committed display paths', async () => {
  const body = await callVerify(['~/assets/images/uploads/my-article/hero-shot.png'], {
    'https://example.com/learn/my-article': () =>
      new Response(pageHtml('<img src="/_astro/hero-shot.C3jHx8yz.webp" alt="hero">'), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    'https://example.com/_astro/hero-shot.C3jHx8yz.webp': webpResponse,
  });

  assert.equal(body.verified, true, JSON.stringify(body));
  assert.equal(body.inconclusive, false);
  assert.equal(body.pageStatus, 200);
  assert.equal(body.images[0].present, true);
  assert.equal(body.images[0].matchedBy, 'filename-stem');
  assert.equal(body.images[0].matchedUrl, 'https://example.com/_astro/hero-shot.C3jHx8yz.webp');
  assert.equal(body.images[0].ok, true);
});

test('verify collects srcset variants and exact URL matches report matchedBy exact', async () => {
  const body = await callVerify(['/images/direct.png', '/_astro/inline-pic.Zx12ab.webp'], {
    'https://example.com/learn/my-article': () =>
      new Response(
        pageHtml(
          '<img src="/images/direct.png">' +
            '<img src="/_astro/other.abc.webp" srcset="/_astro/inline-pic.Zx12ab.webp 400w, /_astro/other.abc.webp 720w">'
        ),
        { status: 200, headers: { 'content-type': 'text/html' } }
      ),
    'https://example.com/images/direct.png': pngResponse,
    'https://example.com/_astro/inline-pic.Zx12ab.webp': webpResponse,
  });

  assert.equal(body.verified, true, JSON.stringify(body));
  assert.equal(body.images[0].matchedBy, 'exact');
  assert.equal(body.images[1].matchedBy, 'exact', 'srcset-only variants must be collected as sources');
});

test('verify reports a definite failure (not inconclusive) when the page is live but the image is absent', async () => {
  const body = await callVerify(['~/assets/images/uploads/my-article/missing-pic.png'], {
    'https://example.com/learn/my-article': () =>
      new Response(pageHtml('<img src="/_astro/unrelated.Aa11bb.webp">'), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  });

  assert.equal(body.verified, false);
  assert.equal(body.inconclusive, false, 'a live page with a missing image is a proven defect, not inconclusive');
  assert.equal(body.images[0].present, false);
  assert.ok(body.images[0].error, 'the missing image must carry an error');
});

test('verify marks a non-200 page as inconclusive with deploy-timing guidance', async () => {
  const body = await callVerify(['~/assets/images/uploads/my-article/hero-shot.png'], {
    'https://example.com/learn/my-article': () => new Response('not deployed yet', { status: 404 }),
  });

  assert.equal(body.verified, false);
  assert.equal(body.inconclusive, true, 'a page that is not live yet must be inconclusive');
  assert.equal(body.pageStatus, 404);
  assert.match(String(body.errors?.[0]), /deploy may not be live yet/);
  assert.match(String(body.errors?.[0]), /deploy_status/);
});

// ---------------------------------------------------------------------------
// expectedDocuments — the PDF-attachment sibling of expectedImages. A
// document media node renders as <a href> + <object data> (render-nodes.ts);
// the assertion is "the public path is on the page in one of those, and it
// fetches as application/pdf". Never an <img>.
// ---------------------------------------------------------------------------

const PDF_SHA = 'c'.repeat(64);
const PDF_PATH = `/pdf/req_agent_pdf_attach_20260831_01/${PDF_SHA}.pdf`;
const PDF_URL = `https://example.com${PDF_PATH}`;
const pdfResponse = () =>
  new Response('%PDF-1.7 bytes', { status: 200, headers: { 'content-type': 'application/pdf' } });

// The fixture page: exactly what render-nodes.ts emits for one image node and
// one document node (download block + <object> preview).
const documentFixturePage = () =>
  pageHtml(
    '<img src="/images/direct.png">' +
      `<figure class="article-node-document not-prose my-6" data-media-type="document">` +
      `<a class="article-document-link" href="${PDF_PATH}" type="application/pdf" download="${PDF_SHA}.pdf">Guide</a>` +
      `<object class="article-document-preview" data="${PDF_PATH}" type="application/pdf"><p>fallback</p></object>` +
      `</figure>`
  );

test('expectedDocuments: a document public path present as <a href>/<object data> and served as application/pdf verifies', async () => {
  const body = await callVerify(
    ['/images/direct.png'],
    {
      'https://example.com/learn/my-article': () =>
        new Response(documentFixturePage(), { status: 200, headers: { 'content-type': 'text/html' } }),
      'https://example.com/images/direct.png': pngResponse,
      [PDF_URL]: pdfResponse,
    },
    { expectedDocuments: [PDF_PATH] }
  );

  assert.equal(body.verified, true, JSON.stringify(body));
  assert.deepEqual(body.expectedDocuments, [PDF_PATH]);
  assert.equal(body.documents?.length, 1);
  assert.equal(body.documents?.[0].present, true);
  assert.equal(body.documents?.[0].matchedBy, 'exact');
  assert.equal(body.documents?.[0].matchedUrl, PDF_URL);
  assert.equal(body.documents?.[0].status, 200);
  assert.equal(body.documents?.[0].contentType, 'application/pdf');
  assert.equal(body.documents?.[0].ok, true);
});

test('expectedDocuments: a PDF that only appears inside an <img> does not count (that is the broken-image defect)', async () => {
  const body = await callVerify(
    [],
    {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml(`<img src="${PDF_PATH}" alt="guide">`), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      [PDF_URL]: pdfResponse,
    },
    { expectedDocuments: [PDF_PATH] }
  );

  assert.equal(body.verified, false);
  assert.equal(body.inconclusive, false, 'a live page with the PDF in an <img> is a proven defect');
  assert.equal(body.documents?.[0].present, false);
  assert.match(String(body.documents?.[0].error), /not found on the page as an <a href>, <object data>/);
  assert.match(String(body.errors?.[0]), new RegExp(PDF_PATH.replace(/\//g, '\\/')));
});

test('expectedDocuments: a linked path that does not serve application/pdf fails with the content-type it got', async () => {
  const body = await callVerify(
    [],
    {
      'https://example.com/learn/my-article': () =>
        new Response(documentFixturePage(), { status: 200, headers: { 'content-type': 'text/html' } }),
      [PDF_URL]: () => new Response('<html>404</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    },
    { expectedDocuments: [PDF_PATH] }
  );

  assert.equal(body.verified, false);
  assert.equal(body.documents?.[0].present, true);
  assert.equal(body.documents?.[0].ok, false);
  assert.match(String(body.documents?.[0].error), /did not return content-type application\/pdf \(got text\/html\)/);
});

test('expectedDocuments: omitted keeps the image-only contract byte-for-byte (no documents key)', async () => {
  const body = await callVerify(['/images/direct.png'], {
    'https://example.com/learn/my-article': () =>
      new Response(pageHtml('<img src="/images/direct.png">'), { status: 200, headers: { 'content-type': 'text/html' } }),
    'https://example.com/images/direct.png': pngResponse,
  });
  assert.equal(body.verified, true);
  assert.equal('documents' in body, false);
  assert.equal('expectedDocuments' in body, false);
});

// ---------------------------------------------------------------------------
// Deploy-aware verification: correlate to the publish commit's Netlify deploy so
// a stale/not-yet-live deploy is deploy TIMING (inconclusive), not a false
// missing-image defect.
// ---------------------------------------------------------------------------

const NETLIFY_DEPLOYS_URL = 'https://api.netlify.com/api/v1/sites/test-site/deploys?per_page=20&page=1';

const deployListResponse = (deploys: Array<Record<string, unknown>>) => () =>
  new Response(JSON.stringify(deploys), { status: 200, headers: { 'content-type': 'application/json' } });

const callVerifyDeployAware = async ({
  payload,
  routes,
  deployConfigured = true,
}: {
  payload: Record<string, unknown>;
  routes: Record<string, () => Response>;
  deployConfigured?: boolean;
}): Promise<VerifyResponseBody> => {
  const prev = {
    site: process.env.NETLIFY_SITE_ID,
    siteAlt: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
    tokenAlt: process.env.NETLIFY_BLOBS_TOKEN,
  };
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  if (deployConfigured) {
    process.env.NETLIFY_SITE_ID = 'test-site';
    process.env.NETLIFY_AUTH_TOKEN = 'test-token';
  } else {
    delete process.env.NETLIFY_SITE_ID;
    delete process.env.SITE_ID;
    delete process.env.NETLIFY_AUTH_TOKEN;
    delete process.env.NETLIFY_BLOBS_TOKEN;
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [route, respond] of Object.entries(routes)) {
      if (url === route) return respond();
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    const response = await verifyHandler({
      httpMethod: 'POST',
      headers: { 'x-publish-key': publishSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/learn/my-article', ...payload }),
    });
    return JSON.parse(response.body) as VerifyResponseBody;
  } finally {
    globalThis.fetch = originalFetch;
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NETLIFY_SITE_ID', prev.site);
    restore('SITE_ID', prev.siteAlt);
    restore('NETLIFY_AUTH_TOKEN', prev.token);
    restore('NETLIFY_BLOBS_TOKEN', prev.tokenAlt);
  }
};

test('deploy-aware: a not-ready deploy is inconclusive even when the live page is missing the image', async () => {
  // The page (previous deploy) 200s WITHOUT the expected image; legacy behavior
  // would call this a proven defect. With the target commit's deploy still
  // building, it must be deploy timing (inconclusive), not a missing-image bug.
  const body = await callVerifyDeployAware({
    payload: { expectedImages: ['~/assets/images/uploads/my-article/hero-shot.png'], commit: 'abc123' },
    routes: {
      [NETLIFY_DEPLOYS_URL]: deployListResponse([{ id: 'dep-building', state: 'building', commit_ref: 'abc123' }]),
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml('<img src="/_astro/unrelated.Aa11bb.webp">'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    },
  });

  assert.equal(body.verified, false, JSON.stringify(body));
  assert.equal(body.inconclusive, true, 'a not-yet-live deploy must be inconclusive, not a defect');
  assert.equal(body.deployReady, false);
  assert.equal(body.deployAware, true);
  assert.deepEqual(body.images, []);
  assert.match(String(body.errors?.[0]), /not live yet|deploy timing/);
});

test('deploy-aware: a ready deploy proves a missing image is a real defect', async () => {
  const body = await callVerifyDeployAware({
    payload: { expectedImages: ['~/assets/images/uploads/my-article/missing-pic.png'], commit: 'abc123' },
    routes: {
      [NETLIFY_DEPLOYS_URL]: deployListResponse([
        { id: 'dep-ready', state: 'ready', commit_ref: 'abc123', ssl_url: 'https://example.com' },
      ]),
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml('<img src="/_astro/unrelated.Aa11bb.webp">'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    },
  });

  assert.equal(body.verified, false, JSON.stringify(body));
  assert.equal(body.inconclusive, false, 'with the target deploy live, a missing image is a proven defect');
  assert.equal(body.deployReady, true);
  assert.equal(body.images[0].present, false);
  assert.ok(body.images[0].error);
});

test('deploy-aware: a ready deploy verifies a present image', async () => {
  const body = await callVerifyDeployAware({
    payload: { expectedImages: ['~/assets/images/uploads/my-article/hero-shot.png'], commit: 'abc123' },
    routes: {
      [NETLIFY_DEPLOYS_URL]: deployListResponse([
        { id: 'dep-ready', state: 'ready', commit_ref: 'abc123', ssl_url: 'https://example.com' },
      ]),
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml('<img src="/_astro/hero-shot.C3jHx8yz.webp" alt="hero">'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      'https://example.com/_astro/hero-shot.C3jHx8yz.webp': webpResponse,
    },
  });

  assert.equal(body.verified, true, JSON.stringify(body));
  assert.equal(body.inconclusive, false);
  assert.equal(body.deployReady, true);
});

test('deploy-aware: a failed deploy is inconclusive with build-failure guidance (not an image defect)', async () => {
  const body = await callVerifyDeployAware({
    payload: { expectedImages: ['~/assets/images/uploads/my-article/hero-shot.png'], commit: 'abc123' },
    routes: {
      [NETLIFY_DEPLOYS_URL]: deployListResponse([
        { id: 'dep-failed', state: 'error', commit_ref: 'abc123', error_message: 'build failed' },
      ]),
    },
  });

  assert.equal(body.verified, false);
  assert.equal(body.inconclusive, true);
  assert.equal(body.deployReady, false);
  assert.match(String(body.errors?.[0]), /did not succeed|build/);
});

test('deploy-aware degrades gracefully when Netlify deploy lookup is not configured', async () => {
  const body = await callVerifyDeployAware({
    deployConfigured: false,
    payload: { expectedImages: ['~/assets/images/uploads/my-article/hero-shot.png'], commit: 'abc123' },
    routes: {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml('<img src="/_astro/hero-shot.C3jHx8yz.webp" alt="hero">'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      'https://example.com/_astro/hero-shot.C3jHx8yz.webp': webpResponse,
    },
  });

  assert.equal(body.deployAware, false, 'without deploy lookup, correlation is skipped but the check still runs');
  assert.equal(body.verified, true, JSON.stringify(body));
  assert.ok(body.deployNote, 'a note explains that deploy correlation was skipped');
});

const NETLIFY_SITE_URL = 'https://api.netlify.com/api/v1/sites/test-site';

const sitePublishedResponse = (publishedDeploy: Record<string, unknown> | null) => () =>
  new Response(JSON.stringify({ published_deploy: publishedDeploy }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('deploy-aware: production published on the target commit is definitive (deployReady + verified)', async () => {
  const body = await callVerifyDeployAware({
    payload: { expectedImages: ['~/assets/images/uploads/my-article/hero-shot.png'], commit: 'abc123' },
    routes: {
      [NETLIFY_DEPLOYS_URL]: deployListResponse([{ id: 'dep-ready', state: 'ready', commit_ref: 'abc123' }]),
      [NETLIFY_SITE_URL]: sitePublishedResponse({
        id: 'dep-ready',
        state: 'ready',
        commit_ref: 'abc123',
        ssl_url: 'https://example.com',
      }),
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml('<img src="/_astro/hero-shot.C3jHx8yz.webp" alt="hero">'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      'https://example.com/_astro/hero-shot.C3jHx8yz.webp': webpResponse,
    },
  });

  assert.equal(body.deployReady, true, JSON.stringify(body));
  assert.equal(body.verified, true);
  assert.equal(body.inconclusive, false);
});

test('deploy-aware: a ready build not yet published to production (locked Auto Publishing) is inconclusive, not a defect', async () => {
  // The build for the target commit is READY, but production is still published
  // on an older commit and the live page therefore lacks the new image. This must
  // NOT be reported as a missing-image defect — it is a publishing-timing state.
  const body = await callVerifyDeployAware({
    payload: { expectedImages: ['~/assets/images/uploads/my-article/hero-shot.png'], commit: 'abc123' },
    routes: {
      [NETLIFY_DEPLOYS_URL]: deployListResponse([{ id: 'dep-ready', state: 'ready', commit_ref: 'abc123' }]),
      [NETLIFY_SITE_URL]: sitePublishedResponse({ id: 'dep-old', state: 'ready', commit_ref: 'oldcommit000000' }),
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml('<img src="/_astro/unrelated.Aa11bb.webp">'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    },
  });

  assert.equal(body.verified, false);
  assert.equal(body.inconclusive, true, 'a ready-but-unpublished build must not assert against stale production');
  assert.equal(body.deployReady, false);
  assert.match(String(body.errors?.[0]), /Auto Publishing|built successfully|publish/i);
});

// ---------------------------------------------------------------------------
// Admin artifact preview (Stage 5.3): blobKeys resolve through admin-get-blob-image
// ---------------------------------------------------------------------------

test('getAdminBlobImageEndpoint builds the admin preview URL for valid image blobKeys only', () => {
  const sha = 'a'.repeat(64);
  assert.equal(
    getAdminBlobImageEndpoint(`image/req_publish_demo_20260703_01/${sha}.png`),
    `/.netlify/functions/admin-get-blob-image?blobKey=${encodeURIComponent(`image/req_publish_demo_20260703_01/${sha}.png`)}`
  );
  assert.equal(getAdminBlobImageEndpoint(`pdf/req_publish_demo_20260703_01/${sha}.pdf`), undefined);
  assert.equal(getAdminBlobImageEndpoint('https://example.com/x.png'), undefined);
  assert.equal(getAdminBlobImageEndpoint('~/assets/images/uploads/slug/x.png'), undefined);
});

test('createAdminArtifactPreviewLoader fetches with the identity token and returns an object URL', async () => {
  const sha = 'b'.repeat(64);
  const blobKey = `image/req_publish_demo_20260703_02/${sha}.png`;
  const requests: Array<{ url: string; authorization: string | undefined }> = [];

  const loader = createAdminArtifactPreviewLoader({
    getToken: async () => 'identity-token-123',
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      });
      return new Response(Buffer.from('png-bytes'), { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch,
    createObjectUrl: () => 'blob:mock-object-url',
  });

  const url = await loader(blobKey);

  assert.equal(url, 'blob:mock-object-url');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.includes(encodeURIComponent(blobKey)));
  assert.equal(requests[0].authorization, 'Bearer identity-token-123');
});

test('createAdminArtifactPreviewLoader resolves undefined on auth failure and non-artifact refs', async () => {
  const loader = createAdminArtifactPreviewLoader({
    getToken: async () => 'identity-token-123',
    fetchFn: (async () => new Response('forbidden', { status: 403 })) as typeof fetch,
    createObjectUrl: () => 'blob:should-not-happen',
  });

  assert.equal(await loader(`image/req_publish_demo_20260703_03/${'c'.repeat(64)}.png`), undefined);
  assert.equal(await loader('not-an-artifact-ref'), undefined);
});
