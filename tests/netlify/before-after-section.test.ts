import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { beforeAfterDefinition } from '../../packages/core/lib/registry/components/before-after.js';
import { isStandalonePlaceableSectionType } from '../../packages/core/lib/registry/components/registered-types.js';
import { resolveSections, type ResolvePageDeps } from '../../packages/core/lib/renderer/resolve.js';
import { sectionInstanceSchema, sectionTypes } from '../../packages/core/schema/bodies/section-v1.js';

const instance = (data: unknown) => ({ id: 's_beforeafter', type: 'before_after', data });
const parses = (data: unknown): boolean => sectionInstanceSchema.safeParse(instance(data)).success;

const minimal = {
  before: { src: '/img/before.webp', alt: 'Skin before the routine', label: 'Before' },
  after: { src: '/img/after.webp', alt: 'Skin after the routine', label: 'After' },
};

test('before_after: exactly one before image and one after image are required', () => {
  assert.ok(parses(minimal));
  assert.ok(!parses({ after: minimal.after }), 'before is required');
  assert.ok(!parses({ before: minimal.before }), 'after is required');
  assert.ok(!parses({ ...minimal, before: { src: '/x.webp', alt: '', label: 'Before' } }), 'alt is required');
  assert.ok(!parses({ ...minimal, after: { src: '/x.webp', alt: 'x', label: '' } }), 'label is required');
  assert.ok(
    !parses({ ...minimal, images: [minimal.before, minimal.after] }),
    'free-form image arrays are rejected by the strict schema'
  );
});

test('before_after: bounded caption and optional standard CTA parse', () => {
  assert.ok(
    parses({
      ...minimal,
      kicker: 'Clinical photography',
      heading: 'Eight weeks apart',
      caption: 'Same lighting and camera position.',
      action: { label: 'Read the methodology', target: { kind: 'route', href: '/methodology' }, style: 'secondary' },
      anchor: 'comparison',
    })
  );
  assert.ok(!parses({ ...minimal, caption: 'x'.repeat(241) }), 'caption is capped at 240 characters');
  assert.ok(!parses({ ...minimal, before: { ...minimal.before, label: 'x'.repeat(49) } }), 'labels are capped at 48');
  assert.ok(
    !parses({ ...minimal, action: { label: 'Bad', href: '/raw-href' } }),
    'CTA must use the standard target contract'
  );
});

test('before_after: optional CTA resolves through the standard action policy', () => {
  const deps = {
    resolveActionHref: (target: { href?: string }) => `resolved:${target.href}`,
    resolveSharedSection: () => {
      throw new Error('not used');
    },
  } as unknown as ResolvePageDeps;

  const withAction = resolveSections(
    [
      instance({
        ...minimal,
        action: { label: 'Learn more', target: { kind: 'route', href: '/learn-more' } },
      }),
    ] as never,
    deps
  );
  assert.deepEqual(withAction[0]!.resolved, { actionHref: 'resolved:/learn-more' });

  const withoutAction = resolveSections([instance(minimal)] as never, deps);
  assert.deepEqual(withoutAction[0]!.resolved, {});
});

test('before_after: registry default is valid, documented, and standalone-placeable', () => {
  assert.ok(isStandalonePlaceableSectionType('before_after'));
  assert.ok((sectionTypes as readonly string[]).includes('before_after'));
  assert.ok((beforeAfterDefinition.editor.useWhen ?? '').length > 20);
  assert.ok(parses(beforeAfterDefinition.editor.defaultData));
  assert.equal(beforeAfterDefinition.footprint.region, 'flow');
});
