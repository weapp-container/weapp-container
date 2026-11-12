/** Exact unchanged issue 1034 source/CLI producer, distinct from WXML and GitHub. */
import { readFileSync } from 'node:fs'
import { createTemporaryProjectProducer } from './conformance-temporary-project-producer.mjs'
export const ISSUE1034_PRODUCER_PROFILE = 'issue1034-static-snapshot-v1'
export const ISSUE1034_PRODUCER_CASE = Object.freeze({ caseId: 'ide-issue-1034-auto-routes-runtime', caseSourcePath: 'e2e/ide/issue-1034-auto-routes.runtime.test.ts',
  sourceSha256: '7af17235a588c76b5cf8cf5f8659b35a7b806ba421ba67e59e5146b2b41f1a4c' })
export const ISSUE1034_PRODUCER_GUARDS = Object.freeze([
  Object.freeze({ path: ISSUE1034_PRODUCER_CASE.caseSourcePath, sha256: ISSUE1034_PRODUCER_CASE.sourceSha256 }),
  Object.freeze({ path: 'e2e/utils/issue1034Project.ts', sha256: 'c0ec21ff441bccbb33f3d0190067948c1bcd299b6843da9ba34d3e1d607e2c40' }),
  Object.freeze({ path: 'e2e/utils/automator.ts', sha256: '3389347206d95d6cbaa3fba9a0f72ab75519868032dc868810019599186f0938' }),
  Object.freeze({ path: 'e2e/utils/automatorBridgeFiles.ts', sha256: 'f136b7809732b7fc6f66cb77ec33fe06ae94dca5b3fae12df492392095e2a95b' }),
  Object.freeze({ path: 'e2e/utils/buildLog.ts', sha256: '1c992ab9649f2a56fa6c37e3d7f9f4f02c254f3427999a51b26146e941419868' }),
  Object.freeze({ path: 'packages/weapp-vite/src/runtime/autoRoutesPlugin/service/persistence.ts', sha256: '6969d85b1c239c49ba025c028fe29ab6c5c1c23b98d8cdf2e71b7b2af57c60f4' }),
  Object.freeze({ path: 'packages/weapp-vite/src/runtime/autoRoutesPlugin/service/shared.ts', sha256: '463ac342c4d24f2144788bddcb008e87fed3aed81214f1cf52424550c1637934' }),
])
export function issue1034ProducerBytes() { return readFileSync(new URL('./conformance-issue1034-producer.mjs', import.meta.url)) }
const producer = createTemporaryProjectProducer({ profile: ISSUE1034_PRODUCER_PROFILE, prefix: 'issue1034', label: 'Issue1034',
  caseIdentity: ISSUE1034_PRODUCER_CASE, guards: ISSUE1034_PRODUCER_GUARDS, tempPrefix: 'issue-1034-', bytes: issue1034ProducerBytes })
export const issue1034ProducerCase = producer.caseFor
export const issue1034ProducerInvocation = producer.invocation
export const verifyIssue1034ProducerGuards = producer.verifyGuards
export const verifyIssue1034ProducerTransaction = producer.verifyTransaction
export const verifyIssue1034SnapshotFinal = producer.verifyFinal
export const verifyIssue1034SourceCleanup = producer.verifySourceCleanup
