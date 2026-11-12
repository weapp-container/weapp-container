// Closed native load diagnostics captured by the isolated QuickJS probe.
// Timing values are fixture data, not a performance acceptance threshold.
const providerStages = {
  "batches": 1,
  "compileNs": null,
  "elapsedNs": 97417,
  "executeIncludingLazyCompileNs": 64875,
  "inputEncodeNs": 12875,
  "lastBatch": {
    "androidTraceEmitted": false,
    "androidTraceEnabled": null,
    "batchSequence": "1",
    "boottimeEndNs": null,
    "boottimeStartNs": null,
    "engine": "quickjs",
    "errorCode": null,
    "modern": false,
    "monotonicEndNs": "1204188791782000",
    "monotonicStartNs": "1204188791685000",
    "operation": "load",
    "ownerThreadId": "384570617",
    "schemaVersion": 1,
    "threadCpuElapsedNs": "97209",
    "threadCpuEndNs": "7936500",
    "threadCpuStartNs": "7839291"
  },
  "outputDecodeNs": 11291,
  "vmInputParseNs": 4750,
  "vmOutputEncodeNs": 2625,
  "inputBytes": 512,
  "documentRegistrations": 1,
  "registeredRenderBatches": 0
};

export function nativeViewMetricsFixture() {
  return {
    preparation: { elapsedNs: 120000, providerInitializationNs: 10000, validationEncodingNs: 1000,
      providerNs: 100000, providerStages: structuredClone(providerStages), cacheHit: false, succeeded: true },
    frontier: { elapsedNs: 130000, documentValidationEncodingNs: 1000, providerNs: 100000,
      providerStages: structuredClone(providerStages), receiptValidationNs: 2000, documentCacheHit: true,
      registrationCacheHits: 1, documentRegistrations: 1, succeeded: true },
    scopeRelease: { elapsedNs: 0, providerNs: 0, providerStages: null, succeeded: true },
  };
}
