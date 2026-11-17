import { nameB, readNameA } from './safe-b'

export const nameA = 'a'

export function cycle(): string {
  return `${nameA}:${nameB}:${readNameA()}`
}
