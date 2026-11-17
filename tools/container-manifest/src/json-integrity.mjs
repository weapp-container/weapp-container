import { createHash } from 'node:crypto';

export function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** JSON canonicalization used for integrity roots and deterministic output. */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
