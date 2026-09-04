/**
 * W2 T2.3 — the dry render-data check behind `validate_pdf_render_data`.
 *
 * The question it answers, without spending a render: *would this `data`
 * satisfy this template's `renderDataSchema`, and are the assets it names
 * actually in the job's asset list?* Those are the two things W1 fails a real
 * job on — `RENDER_DATA_INVALID` at job creation, `ASSET_MISSING` at dispatch
 * — and until now the only way to find out was to create the job and watch it
 * fail.
 *
 * WHY A HAND-ROLLED VALIDATOR. The brief forbids new runtime dependencies and
 * this repo has no JSON-Schema library (W1's ajv-backed enforcement lives in
 * pdf-tool, a different repo). This validates exactly the keyword subset
 * pdf-tool's chromium templates actually use in a `renderDataSchema`
 * (confirmed against `article_brochure_v1.json`, not guessed): `type`
 * (object/string/array), `required`, `properties`, `additionalProperties`
 * (boolean or a sub-schema), `$ref` into `$defs`/`definitions`,
 * `minLength`/`maxLength`/`pattern`, `minItems`/`maxItems`, `minProperties`,
 * `items`, `enum`.
 *
 * A keyword outside that set is REPORTED, not ignored: a schema that outgrows
 * this subset must fail loudly here rather than pass for the wrong reason and
 * then be rejected by ajv on the real job. `authoritative: false` on the
 * result says the same thing in one field — pdf-tool remains the arbiter, and
 * this tool never promises otherwise.
 *
 * (A sibling of this validator exists at `scripts/lib/json-schema-subset.mjs`,
 * written by T2.7 for its seed-time sampleData assertion. They are deliberately
 * not shared: that one is a build script run by `node` directly and cannot
 * import TypeScript, and this one emits ajv-shaped errors and collects asset
 * references, which the seed script has no use for. Noted so the duplication is
 * a decision on the record rather than a discovery.)
 *
 * ERRORS ARE AJV-SHAPED (`instancePath`, `schemaPath`, `keyword`, `message`)
 * because that is the vocabulary the render-side failure speaks, and because a
 * JSON-pointer path is explicitly safe to show an agent or an editor (BRIEF §1).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'minProperties',
  'items',
  'enum',
]);

/** The `$defs` entry name pdf-tool's templates use for a bare job-asset id. */
const ASSET_ID_DEF_NAMES = new Set(['assetId', 'assetid', 'asset_id']);

export type RenderDataSchemaError = {
  /** RFC-6901 JSON pointer into `data`, e.g. `/sections/0/heading`. */
  instancePath: string;
  /** JSON pointer into the schema that rejected it. */
  schemaPath: string;
  keyword: string;
  message: string;
};

export type RenderDataSchemaCheck = {
  valid: boolean;
  errors: RenderDataSchemaError[];
  /**
   * Every bare asset id `data` names through a `$ref` to the schema's
   * `assetId` definition, with the pointer that named it.
   */
  assetRefs: { instancePath: string; assetId: string }[];
  /**
   * False when the schema used a keyword this subset does not implement — the
   * check still ran, but pdf-tool's ajv is the only authority on the result.
   */
  authoritative: boolean;
};

type Ctx = {
  root: Record<string, unknown>;
  errors: RenderDataSchemaError[];
  assetRefs: { instancePath: string; assetId: string }[];
  unsupported: Set<string>;
};

const pointer = (base: string, segment: string | number): string =>
  `${base}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`;

const resolveRef = (ref: string, ctx: Ctx): { schema: Record<string, unknown>; name: string } | undefined => {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = ctx.root;
  let name = '';
  for (const rawSegment of ref.slice(2).split('/')) {
    name = decodeURIComponent(rawSegment.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!isRecord(node)) return undefined;
    node = node[name];
  }
  return isRecord(node) ? { schema: node, name } : undefined;
};

const push = (ctx: Ctx, error: RenderDataSchemaError) => ctx.errors.push(error);

const walk = (schemaIn: unknown, data: unknown, instancePath: string, schemaPath: string, ctx: Ctx): void => {
  if (!isRecord(schemaIn)) return;

  for (const keyword of Object.keys(schemaIn)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) ctx.unsupported.add(keyword);
  }

  let schema = schemaIn;
  let refName: string | undefined;
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, ctx);
    if (!resolved) {
      push(ctx, {
        instancePath,
        schemaPath: `${schemaPath}/$ref`,
        keyword: '$ref',
        message: `unresolvable $ref "${schema.$ref}"`,
      });
      return;
    }
    refName = resolved.name;
    schemaPath = `#/${schema.$ref.slice(2)}`;
    schema = resolved.schema;
  }

  // A bare job-asset id: record it so the caller can check the job's
  // assets.images[] actually contains it (W1's ASSET_MISSING, pre-flight).
  if (refName && ASSET_ID_DEF_NAMES.has(refName) && typeof data === 'string') {
    ctx.assetRefs.push({ instancePath, assetId: data });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === data)) {
    push(ctx, {
      instancePath,
      schemaPath: `${schemaPath}/enum`,
      keyword: 'enum',
      message: 'must be equal to one of the allowed values',
    });
  }

  const type = schema.type;

  if (type === 'object') {
    if (!isRecord(data)) {
      push(ctx, { instancePath, schemaPath: `${schemaPath}/type`, keyword: 'type', message: 'must be object' });
      return;
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && data[key] === undefined) {
        push(ctx, {
          instancePath,
          schemaPath: `${schemaPath}/required`,
          keyword: 'required',
          message: `must have required property '${key}'`,
        });
      }
    }
    if (typeof schema.minProperties === 'number' && Object.keys(data).length < schema.minProperties) {
      push(ctx, {
        instancePath,
        schemaPath: `${schemaPath}/minProperties`,
        keyword: 'minProperties',
        message: `must NOT have fewer than ${schema.minProperties} properties`,
      });
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, value] of Object.entries(data)) {
      const child = properties[key];
      if (isRecord(child)) {
        walk(child, value, pointer(instancePath, key), `${schemaPath}/properties/${key}`, ctx);
        continue;
      }
      if (schema.additionalProperties === false) {
        push(ctx, {
          instancePath,
          schemaPath: `${schemaPath}/additionalProperties`,
          keyword: 'additionalProperties',
          message: `must NOT have additional property '${key}'`,
        });
      } else if (isRecord(schema.additionalProperties)) {
        walk(
          schema.additionalProperties,
          value,
          pointer(instancePath, key),
          `${schemaPath}/additionalProperties`,
          ctx
        );
      }
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(data)) {
      push(ctx, { instancePath, schemaPath: `${schemaPath}/type`, keyword: 'type', message: 'must be array' });
      return;
    }
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
      push(ctx, {
        instancePath,
        schemaPath: `${schemaPath}/minItems`,
        keyword: 'minItems',
        message: `must NOT have fewer than ${schema.minItems} items`,
      });
    }
    if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) {
      push(ctx, {
        instancePath,
        schemaPath: `${schemaPath}/maxItems`,
        keyword: 'maxItems',
        message: `must NOT have more than ${schema.maxItems} items`,
      });
    }
    if (isRecord(schema.items)) {
      data.forEach((entry, index) =>
        walk(schema.items, entry, pointer(instancePath, index), `${schemaPath}/items`, ctx)
      );
    }
    return;
  }

  if (type === 'string') {
    if (typeof data !== 'string') {
      push(ctx, { instancePath, schemaPath: `${schemaPath}/type`, keyword: 'type', message: 'must be string' });
      return;
    }
    if (typeof schema.minLength === 'number' && data.length < schema.minLength) {
      push(ctx, {
        instancePath,
        schemaPath: `${schemaPath}/minLength`,
        keyword: 'minLength',
        message: `must NOT have fewer than ${schema.minLength} characters`,
      });
    }
    if (typeof schema.maxLength === 'number' && data.length > schema.maxLength) {
      push(ctx, {
        instancePath,
        schemaPath: `${schemaPath}/maxLength`,
        keyword: 'maxLength',
        message: `must NOT have more than ${schema.maxLength} characters`,
      });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(data)) {
      push(ctx, {
        instancePath,
        schemaPath: `${schemaPath}/pattern`,
        keyword: 'pattern',
        message: `must match pattern "${schema.pattern}"`,
      });
    }
    return;
  }

  if ((type === 'number' || type === 'integer') && typeof data !== 'number') {
    push(ctx, { instancePath, schemaPath: `${schemaPath}/type`, keyword: 'type', message: `must be ${type}` });
    return;
  }
  if (type === 'boolean' && typeof data !== 'boolean') {
    push(ctx, { instancePath, schemaPath: `${schemaPath}/type`, keyword: 'type', message: 'must be boolean' });
  }
};

/**
 * Validates `data` against a template `renderDataSchema`. Never throws — a
 * schema that is not an object is reported as one error, not a crash, because
 * this runs on whatever a template record happens to carry.
 */
export const checkRenderDataAgainstSchema = (schema: unknown, data: unknown): RenderDataSchemaCheck => {
  if (!isRecord(schema)) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '',
          schemaPath: '#',
          keyword: 'schema',
          message: 'the template declares no usable renderDataSchema (not a JSON object)',
        },
      ],
      assetRefs: [],
      authoritative: false,
    };
  }
  const ctx: Ctx = { root: schema, errors: [], assetRefs: [], unsupported: new Set() };
  walk(schema, data, '', '#', ctx);
  if (ctx.unsupported.size > 0) {
    ctx.errors.push({
      instancePath: '',
      schemaPath: '#',
      keyword: 'unsupportedKeyword',
      message: `this pre-flight check does not implement schema keyword(s): ${[...ctx.unsupported].sort().join(', ')}. pdf-tool's own validator is authoritative for this template.`,
    });
  }
  return {
    valid: ctx.errors.length === 0,
    errors: ctx.errors,
    assetRefs: ctx.assetRefs,
    authoritative: ctx.unsupported.size === 0,
  };
};

export type RenderDataAssetCheck = {
  /** Asset ids `data` names that `assets.images[]` does not supply. */
  missingAssetIds: string[];
  /** Asset ids supplied but never named by `data` — dead weight on the job. */
  unusedAssetIds: string[];
  referencedAssetIds: string[];
  suppliedAssetIds: string[];
};

/**
 * W1's `ASSET_MISSING`, pre-flight: every asset id `data` names must have a
 * matching entry in the job's `assets.images[]`, because pdf-tool serves job
 * assets — and only job assets — at `https://render.assets.invalid/<assetId>`.
 * A slot holding a value the render service cannot fetch fails the WHOLE
 * render; this is how to know before spending one.
 */
export const checkRenderDataAssets = (
  assetRefs: readonly { assetId: string }[],
  assets: unknown
): RenderDataAssetCheck => {
  const images = isRecord(assets) && Array.isArray(assets.images) ? assets.images : [];
  const supplied = new Set<string>();
  for (const entry of images) {
    if (!isRecord(entry)) continue;
    const id = entry.assetId;
    if (typeof id === 'string' && id.length > 0) supplied.add(id);
  }
  const referenced = new Set(assetRefs.map((ref) => ref.assetId));
  return {
    missingAssetIds: [...referenced].filter((id) => !supplied.has(id)).sort(),
    unusedAssetIds: [...supplied].filter((id) => !referenced.has(id)).sort(),
    referencedAssetIds: [...referenced].sort(),
    suppliedAssetIds: [...supplied].sort(),
  };
};
