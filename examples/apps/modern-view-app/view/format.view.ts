import { next } from './shared'

interface User {
  profile?: { name?: string }
}

enum Unit {
  Point = 'points',
}

class Score {
  #weights = new Map<number, number>()

  constructor(values: readonly number[]) {
    for (const [index, value] of values.entries()) {
      this.#weights.set(index, value)
    }
  }

  total(): number {
    let total = 0
    for (const value of this.#weights.values()) total += value
    return total
  }
}

function* unique(values: readonly number[]): Generator<number> {
  yield* new Set(values)
}

export function greeting(user?: User): string {
  return user?.profile?.name ?? 'Modern View'
}

export function summary(values: number[], multiplier = 1): string {
  const [first = 0, ...rest] = [...unique(values)]
  const score = new Score([first, ...rest])
  const result = { total: score.total() * multiplier, unit: Unit.Point }
  return `${result.total} ${result.unit}; exact=${BigInt(result.total).toString()}`
}

export function identity(): string {
  return [].constructor === Array ? 'Standard JS: [].constructor === Array' : 'Unexpected constructor'
}

export function sequence(): number {
  return next()
}
