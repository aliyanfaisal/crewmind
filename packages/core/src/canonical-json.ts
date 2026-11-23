/**
 * Deterministic JSON serialization: object keys sorted by UTF-16 code unit order (as in
 * RFC 8785), no whitespace. The same logical value always produces the same string,
 * which is required before signing (PLAN §4.4).
 *
 * Rules:
 * - Object keys whose value is `undefined` are omitted (same as JSON.stringify).
 * - `undefined` inside arrays, functions, symbols, bigints and non-finite numbers throw:
 *   silently changing signed data would be a security bug.
 * - Only plain objects and arrays are allowed (no Date, Map, class instances).
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported type "${typeof value}" at ${path}`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, i) => {
      if (item === undefined) throw new CanonicalJsonError(`undefined array item at ${path}[${i}]`);
      return serialize(item, `${path}[${i}]`);
    });
    return `[${items.join(',')}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(`non-plain object at ${path}`);
  }

  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialize(v, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}
