/**
 * Reads the site's live `editorial_voice` singleton for the manifest renderer.
 *
 * Tenant-generic by convention, not configuration: the voice singleton id is
 * `voice_<siteShortId>` on every scaffolded site, the same convention the
 * identity uses for `tax_<shortId>` and `trk_<shortId>`.
 *
 * Every failure resolves to `null`, never a throw. A missing or unreadable
 * voice is a WARNING on the rendered bundle (the skill then tells the plugin to
 * read the live object at session start) — it must not take down the admin page
 * that offers the render button.
 */
import { getSiteIdentity } from '../../../lib/site-identity.js';
import { objectRecordKey } from '../object-store-keys.js';
import type { SiteBinding } from '../site-binding.js';
import type { VoiceRecord } from './build-manifest.js';
import type { VoiceForSkill } from './render-skill.js';

type ObjectsStore = { get(key: string, options?: { type?: string }): Promise<unknown> };
type StoreFactory = (event: unknown, binding?: SiteBinding) => Promise<unknown>;

export const voiceObjectIdFor = (siteShortId: string): string => `voice_${siteShortId}`;

export const readVoiceRecord = async (
  event: unknown,
  binding: SiteBinding | undefined,
  storeFactory: StoreFactory
): Promise<VoiceRecord> => {
  const identity = getSiteIdentity();
  const objectId = voiceObjectIdFor(identity.siteShortId);
  let record: unknown;
  try {
    const store = (await storeFactory(event, binding)) as ObjectsStore;
    record = await store.get(objectRecordKey('editorial_voice', objectId), { type: 'json' });
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;

  const asRecord = record as { body?: unknown; record_version?: unknown; version?: unknown };
  const body = asRecord.body;
  if (!body || typeof body !== 'object') return null;

  const version =
    typeof asRecord.record_version === 'number'
      ? asRecord.record_version
      : typeof asRecord.version === 'number'
        ? asRecord.version
        : null;

  return { object_id: objectId, record_version: version, body: body as VoiceForSkill };
};
