/** Addresses and source identities only. Readiness predicate and final expected values live separately. */
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
export const descriptor = freeze({
  "caseId": "ide-github-issues-runtime-import-meta",
  "caseSourcePath": "e2e/ide/github-issues.runtime.import-meta.test.ts",
  "sourceSha256": "87bf4d6ff17686b0b10dcdfd19d21292aa2a5de1f049ad209cbfee98c0cb2c09",
  "sourceGuards": [
    {
      "path": "e2e/ide/github-issues.runtime.import-meta.test.ts",
      "sha256": "87bf4d6ff17686b0b10dcdfd19d21292aa2a5de1f049ad209cbfee98c0cb2c09",
      "bytes": 3280
    },
    {
      "path": "e2e/ide/github-issues.runtime.shared.ts",
      "sha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb",
      "bytes": 53026
    }
  ],
  "plans": [
    {
      "ordinal": 0,
      "fullName": "github-issues runtime import.meta bindings issue #431: renders supported native wxml import.meta bindings at runtime",
      "route": "pages/issue-431/index",
      "steps": [
        {
          "kind": "method.readiness",
          "ordinal": 0,
          "method": "_runE2E",
          "args": [],
          "sourceCallsite": "e2e/ide/github-issues.runtime.import-meta.test.ts:46 readiness callback",
          "helperSha256": "87bf4d6ff17686b0b10dcdfd19d21292aa2a5de1f049ad209cbfee98c0cb2c09",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion",
          "readinessHelperSha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb"
        },
        {
          "kind": "method.call",
          "ordinal": 1,
          "method": "_runE2E",
          "args": [],
          "sourceCallsite": "e2e/ide/github-issues.runtime.import-meta.test.ts:56 final method result",
          "helperSha256": "87bf4d6ff17686b0b10dcdfd19d21292aa2a5de1f049ad209cbfee98c0cb2c09",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": "#issue431-env-label",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue431-image",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": [
                  "src"
                ]
              }
            },
            {
              "selector": "#issue431-double",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue431-single",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue431-script-url",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue431-script-dirname",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        }
      ]
    }
  ],
  "compiledFiles": [
    "pages/issue-431/index.wxml"
  ]
})
