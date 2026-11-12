/** Pinned WXML profile; legacy exports and transaction kinds stay stable. */
import { readFileSync } from 'node:fs'
import { createTemporaryProjectProducer } from './conformance-temporary-project-producer.mjs'
export const WXML_PRODUCER_PROFILE = 'wxml-static-snapshot-v1'
export const WXML_PRODUCER_CASE = Object.freeze({ caseId: 'ide-wxml-transform-runtime', caseSourcePath: 'e2e/ide/wxml-transform.runtime.test.ts',
  sourceSha256: '697e7f72f545f1c8df358930c5ecca297d8888bb16f0cf01a4bc88084392d4a2' })
export const WXML_PRODUCER_GUARDS = Object.freeze([
  Object.freeze({ path: WXML_PRODUCER_CASE.caseSourcePath, sha256: WXML_PRODUCER_CASE.sourceSha256 }),
  Object.freeze({ path: 'e2e/utils/wxmlTransformProject.ts', sha256: '97b2b0b9d2ce864f04498c344481ce322bddcd247ce1f5fd0cac6969356c5db0' }),
  Object.freeze({ path: 'e2e/utils/automator.ts', sha256: '3389347206d95d6cbaa3fba9a0f72ab75519868032dc868810019599186f0938' }),
  Object.freeze({ path: 'e2e/utils/automatorBridgeFiles.ts', sha256: 'f136b7809732b7fc6f66cb77ec33fe06ae94dca5b3fae12df492392095e2a95b' }),
  Object.freeze({ path: 'e2e/utils/buildLog.ts', sha256: '1c992ab9649f2a56fa6c37e3d7f9f4f02c254f3427999a51b26146e941419868' }),
])
export function wxmlProducerBytes() { return readFileSync(new URL('./conformance-wxml-producer.mjs', import.meta.url)) }
const producer = createTemporaryProjectProducer({ profile: WXML_PRODUCER_PROFILE, prefix: 'wxml', label: 'WXML',
  caseIdentity: WXML_PRODUCER_CASE, guards: WXML_PRODUCER_GUARDS, tempPrefix: 'wxml-transform-', bytes: wxmlProducerBytes })
export const wxmlProducerCase = producer.caseFor
export const wxmlProducerInvocation = producer.invocation
export const verifyWxmlProducerGuards = producer.verifyGuards
export const verifyWxmlProducerTransaction = producer.verifyTransaction
export const verifyWxmlSnapshotFinal = producer.verifyFinal
export const verifyWxmlSourceCleanup = producer.verifySourceCleanup
