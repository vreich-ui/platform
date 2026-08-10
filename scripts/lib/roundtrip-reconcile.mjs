/**
 * Pure reconcile helpers for the home-conversion round-trip driver
 * (scripts/home-conversion-roundtrip.mjs) — extracted so the drift-healing
 * logic is unit-testable offline (tests/scripts/roundtrip-reconcile.test.mjs).
 *
 * The hard-won rule encoded here is playbook trap 2: `set_page_meta` (like
 * every fields op) DEEP-MERGES object values onto the existing record, so a
 * key the target omits but the current record carries survives the merge
 * unless it is explicitly set to `null` (null = delete). The first production
 * heal of page_home (2026-07-10) missed this: three stray `seo` subkeys
 * survived and the reconciled body failed the byte-identical check.
 */

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Build the `fields` payload that transforms `current` into `target` under
 * deep-merge semantics: target values win, and any key present in `current`
 * but absent from `target` — at ANY depth where both sides are plain objects —
 * is explicitly nulled so the merge deletes it. Arrays and scalars replace
 * wholesale (the merge does not recurse into them).
 */
export const diffFieldsForMerge = (target, current) => {
  const fields = {};
  const targetObj = isPlainObject(target) ? target : {};
  const currentObj = isPlainObject(current) ? current : {};
  for (const key of new Set([...Object.keys(targetObj), ...Object.keys(currentObj)])) {
    const targetValue = targetObj[key];
    const currentValue = currentObj[key];
    if (targetValue === undefined) {
      fields[key] = null; // stray key: delete
    } else if (isPlainObject(targetValue) && isPlainObject(currentValue)) {
      fields[key] = diffFieldsForMerge(targetValue, currentValue); // recurse: null nested strays
    } else {
      fields[key] = targetValue; // scalar/array/new object: replace wholesale
    }
  }
  return fields;
};

const deepEqual = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
    return true;
  }
  return false; // a !== b, neither array nor plain object: primitives that differ
};

/**
 * Field-level DRIFT report for read-only verification (T16.8's `--verify`):
 * `diffFieldsForMerge` doubles as a heal-op payload builder (see `reconcileOps`
 * below), so it always reports the FULL target shape — every top-level key
 * target carries, whether or not `current` already matches it — because that
 * whole shape is what a real `set_X_fields` call needs to send. A read-only
 * verifier wants the opposite: only the keys that actually differ. This
 * reuses `diffFieldsForMerge`'s exact merge-aware structure (recurse into
 * keys that are plain objects on both sides, treat arrays/scalars as atomic,
 * per playbook trap 2) and prunes away every entry that already matches, so
 * what's left is a true drift diff — empty `{}` means `current` already
 * equals `target` under merge semantics.
 */
export const driftFields = (target, current) => {
  const fields = diffFieldsForMerge(target, current);
  const prune = (node, currentNode) => {
    const currentObj = isPlainObject(currentNode) ? currentNode : {};
    const kept = {};
    for (const [key, value] of Object.entries(node)) {
      if (value === null) {
        if (key in currentObj) kept[key] = null; // a real stray key, still present on the record
        continue;
      }
      if (isPlainObject(value) && isPlainObject(currentObj[key])) {
        const nested = prune(value, currentObj[key]);
        if (Object.keys(nested).length > 0) kept[key] = nested;
        continue;
      }
      if (!deepEqual(value, currentObj[key])) kept[key] = value;
    }
    return kept;
  };
  return prune(fields, current);
};

const PAGE_META_KEYS = ['route', 'pageType', 'title', 'seo', 'navigationOverrides', 'template'];
// set_template_meta forbids 'slots' (the slot ops own them) — mirror that split.
// W8.3b: the recipe-metadata trio is meta too (this is what backfills the 3
// live tpl_* records when the enriched seeds run through ensure at W8.4).
const TEMPLATE_META_KEYS = ['name', 'description', 'whenToUse', 'scope', 'appliesTo'];
// set_section_template_meta forbids 'blueprint' (replace_blueprint owns it).
const SECTION_TEMPLATE_META_KEYS = ['name', 'description', 'whenToUse', 'scope'];

/**
 * The patch ops that heal a drifted record back to its seed body.
 *
 * - section objects: the wrapper holds exactly one instance; `upsert_section`
 *   replaces it wholesale — one op, no merge pitfalls.
 * - page objects: meta first (so structure_home_footer sees the footer
 *   override immediately), via diffFieldsForMerge against the CURRENT record's
 *   meta (nulling strays at every depth); then per-section upserts (wholesale
 *   replace by id), removal of stray sections, and explicit final ordering.
 * - template objects (W2.5): the same shape as pages with slots in place of
 *   sections — meta diff (name/appliesTo; set_template_meta forbids `slots`),
 *   positioned per-slot upserts, stray-slot removal, explicit final ordering.
 * - taxonomy objects (W3): a drifted kind is rebuilt WHOLESALE — remove every
 *   current term (in reverse), then add_term each target term in order with its
 *   full payload. Blunt but exact: there is no reorder op, and update_term slug
 *   renames mint deprecated aliases (C§2.3-taxonomy) that would leave the healed
 *   body differing from the seed. A kind already matching the seed is untouched.
 * - section_template objects (W8.3b): meta diff (name/description/whenToUse/
 *   scope; set_section_template_meta forbids `blueprint`) + wholesale
 *   blueprint replacement — the shared-section idiom one level up.
 * - theme objects (W8.3b): one fields bag, set_theme_fields — the site idiom.
 */
export const reconcileOps = (seed, currentBody) => {
  if (seed.objectType === 'section') {
    return [{ op: 'upsert_section', section: seed.body.section }];
  }
  if (seed.objectType === 'site') {
    // The singleton is one fields bag; set_site_fields heals every field via a
    // deep-merge diff against the current record, nulling strays at every depth
    // (trap 2). EXCEPT brandTokens: that field is theme-governed (Wolf
    // 2026-07-15) — set_site_fields refuses it, so the reconcile driver never
    // touches the palette. Palette drift is healed by applying a theme
    // (site_apply_theme of the canonical thm_drlurie_default), not by reconcile.
    const stripPalette = (body) => {
      const rest = { ...(isPlainObject(body) ? body : {}) };
      delete rest.brandTokens;
      return rest;
    };
    const fields = diffFieldsForMerge(stripPalette(seed.body), stripPalette(currentBody));
    return Object.keys(fields).length > 0 ? [{ op: 'set_site_fields', fields }] : [];
  }
  if (seed.objectType === 'taxonomy') {
    const current = isPlainObject(currentBody) ? currentBody : {};
    const ops = [];
    for (const kind of ['category', 'tag']) {
      const targetTerms = seed.body.kinds?.[kind]?.terms ?? [];
      const currentTerms = Array.isArray(current.kinds?.[kind]?.terms) ? current.kinds[kind].terms : [];
      if (JSON.stringify(currentTerms) === JSON.stringify(targetTerms)) continue;
      for (const entry of [...currentTerms].reverse()) {
        if (entry && typeof entry.term_id === 'string') {
          ops.push({ op: 'remove_term', kind, term_id: entry.term_id });
        }
      }
      targetTerms.forEach((entry, index) => {
        ops.push({ op: 'add_term', kind, term: entry, position: index });
      });
    }
    return ops;
  }
  if (seed.objectType === 'section_template') {
    // The wrapper holds ONE blueprint (replace wholesale, the shared-section
    // idiom) plus a meta bag (diffed with stray-nulling, trap 2).
    const current = isPlainObject(currentBody) ? currentBody : {};
    const pickMeta = (source) =>
      Object.fromEntries(
        SECTION_TEMPLATE_META_KEYS.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]]))
      );
    return [
      { op: 'set_section_template_meta', fields: diffFieldsForMerge(pickMeta(seed.body), pickMeta(current)) },
      { op: 'replace_blueprint', blueprint: seed.body.blueprint },
    ];
  }
  if (seed.objectType === 'theme') {
    // One fields bag and set_theme_fields is its only op — the site idiom.
    return [{ op: 'set_theme_fields', fields: diffFieldsForMerge(seed.body, currentBody) }];
  }
  if (seed.objectType === 'tracking_config') {
    // The registry singleton (T13.10): set_tracking_config_fields is the
    // whole surface — open deep-merge over the body, strays nulled at every
    // depth (trap 2). The fixed-key providers object makes plain merge safe.
    return [{ op: 'set_tracking_config_fields', fields: diffFieldsForMerge(seed.body, currentBody) }];
  }
  if (seed.objectType === 'template') {
    const target = seed.body;
    const current = isPlainObject(currentBody) ? currentBody : {};
    const targetSlotIds = new Set(target.slots.map((slot) => slot.slotId));
    const ops = [];

    const pickMeta = (source) =>
      Object.fromEntries(TEMPLATE_META_KEYS.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])));
    ops.push({ op: 'set_template_meta', fields: diffFieldsForMerge(pickMeta(target), pickMeta(current)) });

    target.slots.forEach((slot, index) => {
      ops.push({ op: 'upsert_slot', slot, position: index });
    });
    const currentSlots = Array.isArray(current.slots) ? current.slots : [];
    for (const slot of currentSlots) {
      if (slot && typeof slot.slotId === 'string' && !targetSlotIds.has(slot.slotId)) {
        ops.push({ op: 'remove_slot', slot_id: slot.slotId });
      }
    }
    // upsert leaves pre-existing slots in place — pin the final order explicitly.
    target.slots.forEach((slot, index) => {
      ops.push({ op: 'move_slot', slot_id: slot.slotId, to_index: index });
    });
    return ops;
  }
  const target = seed.body;
  const current = isPlainObject(currentBody) ? currentBody : {};
  const targetIds = new Set(target.sections.map((section) => section.id));
  const ops = [];

  const pick = (source) =>
    Object.fromEntries(PAGE_META_KEYS.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])));
  ops.push({ op: 'set_page_meta', fields: diffFieldsForMerge(pick(target), pick(current)) });

  target.sections.forEach((section, index) => {
    ops.push({ op: 'upsert_section', section, position: index });
  });
  const currentSections = Array.isArray(current.sections) ? current.sections : [];
  for (const section of currentSections) {
    if (section && typeof section.id === 'string' && !targetIds.has(section.id)) {
      ops.push({ op: 'remove_section', section_id: section.id });
    }
  }
  // upsert leaves pre-existing sections in place — pin the final order explicitly.
  target.sections.forEach((section, index) => {
    ops.push({ op: 'move_section', section_id: section.id, to_index: index });
  });
  return ops;
};
