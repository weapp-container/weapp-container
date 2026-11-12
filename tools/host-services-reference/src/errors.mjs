export class ServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ServiceError'; this.code = code; this.status = status;
  }
}
export const requireThat = (condition, code, message, status = 400) => {
  if (!condition) throw new ServiceError(code, message, status);
};
export function text(value, name, max = 256) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value),
    'invalid_request', `${name} must be a nonempty string`);
  return value;
}
export function epoch(value) {
  requireThat(typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n,
    'invalid_request', 'principalEpoch must be a positive decimal u64 string');
  return value;
}
export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_request', `${name} is outside its integer range`);
  return value;
}
