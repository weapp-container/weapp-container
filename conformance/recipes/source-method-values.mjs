/** Lossless method return projection for explicit undefined or plain acyclic JSON. No JSON stringify coercions. */
const require = (condition, message) => { if (!condition) throw new Error(message) }
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { require(Number.isFinite(value), 'Method value must be JSON finite'); return value }
  require(value && typeof value === 'object' && !ancestors.has(value)
    && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))), 'Method value must be plain acyclic JSON')
  require(Object.getOwnPropertySymbols(value).length === 0, 'Method value cannot contain symbols')
  ancestors.add(value)
  let output
  if (Array.isArray(value)) {
    require(Object.keys(value).length === value.length, 'Method array cannot contain holes or extra keys')
    output = Array.from({ length: value.length }, (_, at) => {
      const property = Object.getOwnPropertyDescriptor(value, String(at))
      require(property && Object.hasOwn(property, 'value'), 'Method array cannot contain accessors or holes')
      return copyJson(property.value, ancestors)
    })
  } else {
    output = {}
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key)
      require(property && Object.hasOwn(property, 'value'), 'Method object cannot contain accessors')
      Object.defineProperty(output, key, { enumerable: true, configurable: true, writable: true, value: copyJson(property.value, ancestors) })
    }
  }
  ancestors.delete(value)
  return output
}
export const encodeMethodValue = value => value === undefined ? { kind: 'undefined' } : { kind: 'json', value: copyJson(value) }
export function decodeMethodValue(value) {
  require(keys(value) === 'kind' && value.kind === 'undefined'
    || keys(value) === 'kind,value' && value.kind === 'json', 'Method fulfilled value is not an explicit undefined or JSON value')
  return value.kind === 'undefined' ? undefined : copyJson(value.value)
}
export function methodArguments(value) {
  require(Array.isArray(value), 'Method arguments require an actual array')
  return copyJson(value)
}
