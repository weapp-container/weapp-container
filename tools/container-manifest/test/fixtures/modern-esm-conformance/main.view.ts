import { counter, bump } from './state'
import { cycle } from './safe-a'

enum Unit {
  Point = 'points',
}

class Box {
  #value = 0

  constructor(values: Iterable<number>) {
    for (const value of values) this.#value += value
  }

  get value(): number {
    return this.#value
  }
}

function* unique(values: Iterable<number>): Generator<number> {
  yield* new Set(values)
}

export function exercise(): string {
  const before = counter
  bump()
  const box = new Box(unique([1, 2, 2, 3]))
  return `before=${before};after=${counter};sum=${box.value};unit=${Unit.Point};cycle=${cycle()}`
}

export function readImported(): number {
  return counter
}
