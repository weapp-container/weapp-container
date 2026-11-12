/** Linux entry is explicitly bound to the native software presenter. The
 * common driver retains the exact replay, collectors and admission contract. */
import { createDriver } from './driver.mjs'
const driver = createDriver({ host: 'linux', presenter: 'software' })
export const run = driver.run
export const runDiagnostic = driver.runDiagnostic
export const dispose = driver.dispose
