import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readTrackingExperiments } from './tracking-config-read.js';
import type { SiteBinding } from './site-binding.js';

const binding = { siteId: 'site_drlurie' } as SiteBinding;

const active = {
  object_id: 'req_a_20260901_01',
  arms: [{ variant_id: 'req_a_20260901_01', route: '/a' }],
  status: 'active',
};

const storeWith = (experiments: unknown) => {
  const record = { body: { experiments } };
  return async () => ({
    async list() {
      return { blobs: [{ key: 'objects/tracking_config/index/by-status/active/trk_drlurie' }] };
    },
    async get(key: string) {
      return key === 'objects/tracking_config/by-id/trk_drlurie.json' ? JSON.stringify(record) : null;
    },
  });
};

describe('readTrackingExperiments', () => {
  it('returns experiments[] from the trk_<site> record', async () => {
    const result = await readTrackingExperiments(binding, { getObjectsStore: storeWith([active]) });
    assert.deepEqual(result, [active]);
  });

  it('returns [] when the registry index is empty (no tracking_config record yet)', async () => {
    const getObjectsStore = async () => ({
      async list() {
        return { blobs: [] };
      },
      async get() {
        return null;
      },
    });
    assert.deepEqual(await readTrackingExperiments(binding, { getObjectsStore }), []);
  });

  it('returns [] rather than throwing when the store itself fails', async () => {
    const getObjectsStore = async () => {
      throw new Error('no store in this test');
    };
    assert.deepEqual(await readTrackingExperiments(binding, { getObjectsStore }), []);
  });

  it('returns [] when the record body carries no experiments field at all', async () => {
    const result = await readTrackingExperiments(binding, { getObjectsStore: storeWith(undefined) });
    assert.deepEqual(result, []);
  });

  it('drops malformed entries rather than throwing on shape', async () => {
    const malformed = { object_id: 'req_b_1', status: 'active' }; // no arms[]
    const result = await readTrackingExperiments(binding, {
      getObjectsStore: storeWith([active, malformed, 'nonsense']),
    });
    assert.deepEqual(result, [active]);
  });

  it('carries draft and concluded entries through too — filtering to active is the CALLER’s job', async () => {
    const draft = { ...active, object_id: 'req_c_1', status: 'draft' };
    const result = await readTrackingExperiments(binding, { getObjectsStore: storeWith([active, draft]) });
    assert.deepEqual(result, [active, draft]);
  });
});
