let sequence = 0

export function next(): number {
  return ++sequence
}

export function current(): number {
  return sequence
}
