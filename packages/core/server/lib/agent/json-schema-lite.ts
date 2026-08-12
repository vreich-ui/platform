/**
 * T9.13/PF5 — a dependency-free validator for exactly the JSON-Schema subset
 * `TOOL_DEFINITIONS`' `inputSchema`s actually use (mcp-tool-definitions.ts /
 * -2.ts). NOT a general-purpose JSON-Schema engine: `compileSchema` THROWS at
 * compile time on any keyword outside the supported set (loud, never
 * silently permissive) — a new keyword showing up in a future tool
 * definition fails the build instead of quietly validating nothing.
 *
 * The supported set was collected by walking all 67 definitions' inputSchemas
 * (see generated-tools.test.ts's own compile-everything test): type,
 * properties, required, additionalProperties, enum, minLength, maxLength,
 * minimum, maximum, maxItems, items, anyOf, description, default, format,
 * pattern. Notably NOT present anywhere in those 67: minItems — every
 * `ops`/`entries`-shaped array in the generated (object_*) tool definitions
 * is unconstrained on length; the "at least one op" constraint chat's
 * hand-written `patch` tool enforces in tools.ts is NOT part of any of these
 * schemas, so it is intentionally absent here too (generated-tools.ts's own
 * object_patch ops-name check is a separate, additional hook — see its
 * header).
 */

export type JsonSchemaLiteResult = { ok: true } | { ok: false; error: string };
export type CompiledSchema = (value: unknown) => JsonSchemaLiteResult;

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'maxItems',
  'items',
  'anyOf',
  'description',
  'default',
  'format',
  'pattern',
]);

const SUPPORTED_TYPES = new Set(['object', 'string', 'integer', 'number', 'boolean', 'array', 'null']);

type Checker = (value: unknown, path: string, errors: string[]) => void;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const label = (path: string): string => (path.length > 0 ? path : '(value)');

const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
};

const childPath = (path: string, key: string): string => (path.length > 0 ? `${path}.${key}` : key);
const indexPath = (path: string, index: number): string => `${label(path)}[${index}]`;

/**
 * Recursively compiles one schema node, throwing IMMEDIATELY (compile time,
 * before any value is ever checked) if the node — or any node it contains,
 * via properties/items/anyOf — carries a keyword outside SUPPORTED_KEYWORDS.
 */
const compileNode = (schema: unknown, where: string): Checker => {
  if (!isPlainObject(schema)) {
    throw new Error(`json-schema-lite: schema node at ${where} must be a plain object.`);
  }

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`json-schema-lite: unsupported keyword "${key}" at ${where} — extend the supported set deliberately, do not silently ignore it.`);
    }
  }

  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type !== undefined && !SUPPORTED_TYPES.has(type)) {
    throw new Error(`json-schema-lite: unsupported type "${type}" at ${where}.`);
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
  const pattern = typeof schema.pattern === 'string' ? new RegExp(schema.pattern) : undefined;
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  const additionalProperties = schema.additionalProperties;

  const propertyCheckers = new Map<string, Checker>();
  if (isPlainObject(schema.properties)) {
    for (const [key, subschema] of Object.entries(schema.properties)) {
      propertyCheckers.set(key, compileNode(subschema, `${where}.properties.${key}`));
    }
  }
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((v) => typeof v === 'string') : undefined;

  const itemsChecker = schema.items !== undefined ? compileNode(schema.items, `${where}.items`) : undefined;

  const anyOfCheckers = Array.isArray(schema.anyOf)
    ? schema.anyOf.map((sub, index) => compileNode(sub, `${where}.anyOf[${index}]`))
    : undefined;

  return (value, path, errors) => {
    // anyOf: valid iff at least one branch validates cleanly. This codebase's
    // anyOf usages carry no sibling constraining keywords (only description),
    // so matching one branch is the whole check.
    if (anyOfCheckers) {
      const matched = anyOfCheckers.some((check) => {
        const branchErrors: string[] = [];
        check(value, path, branchErrors);
        return branchErrors.length === 0;
      });
      if (!matched) {
        errors.push(`${label(path)}: does not match any allowed shape`);
      }
      return;
    }

    if (type !== undefined && !matchesType(value, type)) {
      errors.push(`${label(path)}: expected ${type}`);
      return;
    }

    if (enumValues && !enumValues.some((allowed) => allowed === value)) {
      errors.push(`${label(path)}: must be one of ${enumValues.map((v) => JSON.stringify(v)).join(', ')}`);
      return;
    }

    if (typeof value === 'string') {
      if (minLength !== undefined && value.length < minLength) {
        errors.push(`${label(path)}: must be at least ${minLength} character(s)`);
      }
      if (maxLength !== undefined && value.length > maxLength) {
        errors.push(`${label(path)}: must be at most ${maxLength} character(s)`);
      }
      if (pattern && !pattern.test(value)) {
        errors.push(`${label(path)}: does not match the required pattern`);
      }
      if (format === 'date-time' && Number.isNaN(Date.parse(value))) {
        errors.push(`${label(path)}: must be a valid ISO date-time string`);
      }
    }

    if (typeof value === 'number') {
      if (minimum !== undefined && value < minimum) errors.push(`${label(path)}: must be >= ${minimum}`);
      if (maximum !== undefined && value > maximum) errors.push(`${label(path)}: must be <= ${maximum}`);
    }

    if (Array.isArray(value)) {
      if (maxItems !== undefined && value.length > maxItems) {
        errors.push(`${label(path)}: must have at most ${maxItems} item(s)`);
      }
      if (itemsChecker) {
        value.forEach((item, index) => itemsChecker(item, indexPath(path, index), errors));
      }
    }

    if (isPlainObject(value)) {
      if (required) {
        for (const key of required) {
          if (!(key in value) || value[key] === undefined) {
            errors.push(`${childPath(path, key)}: is required`);
          }
        }
      }
      for (const [key, checker] of propertyCheckers) {
        if (key in value && value[key] !== undefined) {
          checker(value[key], childPath(path, key), errors);
        }
      }
      if (additionalProperties === false) {
        const allowed = propertyCheckers;
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) {
            errors.push(`${childPath(path, key)}: unexpected property`);
          }
        }
      }
    }
  };
};

/**
 * Compile a JSON-Schema-lite `inputSchema` into a reusable validator.
 * Throws (at compile time, i.e. right here — never lazily on first use) if
 * the schema uses any keyword this module does not support.
 */
export const compileSchema = (schema: Record<string, unknown>): CompiledSchema => {
  const checker = compileNode(schema, '<schema>');
  return (value) => {
    const errors: string[] = [];
    checker(value, '', errors);
    return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join('; ') };
  };
};
