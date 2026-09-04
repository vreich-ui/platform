/**
 * T2.7 — a hand-rolled validator for the EXACT JSON Schema keyword subset
 * pdf-tool's chromium templates use in their `renderDataSchema` (confirmed
 * against `article_brochure_v1.json`'s renderDataSchema, not guessed):
 * `type` ('object' | 'string' | 'array'), `required`, `properties`,
 * `additionalProperties` (boolean or a schema, for a `Record<string, T>`),
 * `$ref` (`#/$defs/<name>` only, resolved against the root schema passed
 * in), `minLength`/`maxLength`/`pattern` (string), `minItems`/`maxItems`
 * (array `items`), `minProperties` (object).
 *
 * This is NOT a general JSON Schema (draft 2020-12) implementation — no
 * `oneOf`/`anyOf`/`allOf`, no `enum`, no numeric bounds, no external `$ref`.
 * Platform has no JSON-schema-validation dependency today (W1's
 * `RENDER_DATA_INVALID` enforcement lives in pdf-tool, a separate repo) and
 * the brief forbids a new one, so this exists ONLY to prove one thing at
 * seed time: "does this tenant's branded `sampleData` still satisfy
 * `article_brochure_v1`'s `renderDataSchema` after the brand swap" — the
 * acceptance-mandated assertion. A keyword this module doesn't recognize is
 * reported as an error rather than silently ignored, so a schema that
 * outgrows this subset fails loudly instead of passing for the wrong
 * reason.
 */

const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  '$schema',
  '$id',
  '$defs',
  'title',
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
]);

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const resolveRef = (ref, root, path, errors) => {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) {
    errors.push(`${path}: unsupported $ref '${String(ref)}' (only '#/$defs/<name>' is supported)`);
    return undefined;
  }
  const name = ref.slice('#/$defs/'.length);
  const defs = isRecord(root.$defs) ? root.$defs : undefined;
  const resolved = defs?.[name];
  if (!isRecord(resolved)) {
    errors.push(`${path}: $ref '${ref}' does not resolve under $defs`);
    return undefined;
  }
  return resolved;
};

const walk = (schemaIn, data, path, root, errors) => {
  for (const key of Object.keys(schemaIn)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      errors.push(`${path}: unsupported schema keyword '${key}'`);
    }
  }

  let schema = schemaIn;
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, root, path, errors);
    if (!resolved) return;
    schema = resolved;
  }

  const type = schema.type;
  if (type === 'object') {
    if (!isRecord(data)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && data[key] === undefined) {
        errors.push(`${path}: missing required property '${key}'`);
      }
    }
    const minProperties = schema.minProperties;
    if (typeof minProperties === 'number' && Object.keys(data).length < minProperties) {
      errors.push(`${path}: expected at least ${minProperties} propert${minProperties === 1 ? 'y' : 'ies'}`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const additionalProperties = schema.additionalProperties;
    for (const [key, value] of Object.entries(data)) {
      const propSchema = properties[key];
      if (isRecord(propSchema)) {
        walk(propSchema, value, `${path}.${key}`, root, errors);
        continue;
      }
      if (additionalProperties === false) {
        errors.push(`${path}: unexpected property '${key}'`);
      } else if (isRecord(additionalProperties)) {
        walk(additionalProperties, value, `${path}.${key}`, root, errors);
      }
      // additionalProperties === true, or absent (draft default: allowed) -> no check.
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`${path}: expected an array`);
      return;
    }
    const minItems = schema.minItems;
    if (typeof minItems === 'number' && data.length < minItems) {
      errors.push(`${path}: expected at least ${minItems} item${minItems === 1 ? '' : 's'}`);
    }
    const maxItems = schema.maxItems;
    if (typeof maxItems === 'number' && data.length > maxItems) {
      errors.push(`${path}: expected at most ${maxItems} item${maxItems === 1 ? '' : 's'}`);
    }
    const items = schema.items;
    if (isRecord(items)) {
      data.forEach((item, index) => walk(items, item, `${path}[${index}]`, root, errors));
    }
    return;
  }

  if (type === 'string') {
    if (typeof data !== 'string') {
      errors.push(`${path}: expected a string`);
      return;
    }
    const minLength = schema.minLength;
    if (typeof minLength === 'number' && data.length < minLength) {
      errors.push(`${path}: expected at least ${minLength} character${minLength === 1 ? '' : 's'}`);
    }
    const maxLength = schema.maxLength;
    if (typeof maxLength === 'number' && data.length > maxLength) {
      errors.push(`${path}: expected at most ${maxLength} character${maxLength === 1 ? '' : 's'}`);
    }
    const pattern = schema.pattern;
    if (typeof pattern === 'string' && !new RegExp(pattern).test(data)) {
      errors.push(`${path}: does not match pattern ${pattern}`);
    }
    return;
  }

  // No (or an unsupported) `type` at this node -- nothing further to check.
};

/**
 * Validates `data` against `schema`, resolving any `$ref` against `root`
 * (defaults to `schema` itself — pass the top-level schema explicitly when
 * validating a sub-schema so `$ref`s still resolve against its `$defs`).
 * Returns `{ valid, errors }`.
 */
export const validateAgainstSchema = (schema, data, root = schema) => {
  const errors = [];
  walk(schema, data, '$', root, errors);
  return { valid: errors.length === 0, errors };
};
