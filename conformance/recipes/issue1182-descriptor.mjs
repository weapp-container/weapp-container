/** Exact source addresses and field selections. No expected rendered values. */
export const descriptor = Object.freeze({
  "schemaVersion": 1,
  "caseId": "ide-issue-1182-production-mount-runtime",
  "caseSourcePath": "e2e/ide/issue-1182-production-mount.runtime.test.ts",
  "sourceSha256": "618a54f29892015fa49dd32b960179d90ee19c02a452883b4ca6f892e58e65d7",
  "compiledFiles": [
    "app.json",
    "pages/index/index.js",
    "pages/index/index.json",
    "pages/index/index.wxml"
  ],
  "sourceGuards": {
    "e2e/utils/issueRegressionProject.ts": "2d8273959588ccdc121292dcad87ea87a64c0001e4c8de33e93df6dbbec14b99",
    "e2e/utils/automator.ts": "3389347206d95d6cbaa3fba9a0f72ab75519868032dc868810019599186f0938",
    "packages/miniprogram-automator/src/MiniProgram.ts": "08a130c2ca3fde68edbc588b867bbcb710013015676a35100923b97874e0d832",
    "packages/miniprogram-automator/src/Page.ts": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685"
  },
  "fixtureInputs": [
    {
      "path": "package.json",
      "sha256": "ecb9b5f5074136dfa6c61e2c086912c0aa49628ee5d1c444e3e50c511967a938",
      "bytes": 83
    },
    {
      "path": "project.config.json",
      "sha256": "f80471e9d1345b8b5ffcbd9ea5275efb0da676539f6a84967ee6939d827c72ce",
      "bytes": 326
    },
    {
      "path": "project.private.config.json",
      "sha256": "ee7a73485b03eb414c940e3bf0e3ea816f9617b0d2fc7b22c92edcefe49f36fd",
      "bytes": 317
    },
    {
      "path": "src/app.json",
      "sha256": "0cec08f5ab8d72ec034df15a2445b1f1f22a0393536354d9b7b111ab2a94f797",
      "bytes": 37
    },
    {
      "path": "src/app.ts",
      "sha256": "46e497cac54cda5ceb4dfc349a56a666de7eb77a8cfd25382dbfd4d10abb5569",
      "bytes": 48
    },
    {
      "path": "src/pages/index/index.json",
      "sha256": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
      "bytes": 3
    },
    {
      "path": "src/pages/index/index.ts",
      "sha256": "c417ff05920714787eaa177d5d02f36374f27b5f60df5e753f21364d95c81e23",
      "bytes": 1478
    },
    {
      "path": "src/pages/index/index.wxml",
      "sha256": "cbc2d87ccaea269eca1f4a60c873cdb9b37a98d5ef73b05c99d4a2f38518d676",
      "bytes": 405
    },
    {
      "path": "vite.config.ts",
      "sha256": "73ebe97895eafcfa1886e4c08bd8c51fc89702fd18b91d086cc9caacfae6b09c",
      "bytes": 155
    }
  ],
  "exceptionCapture": {
    "auxiliaryListener": {
      "helperSha256": "3389347206d95d6cbaa3fba9a0f72ab75519868032dc868810019599186f0938",
      "registerCallsite": "e2e/utils/automator.ts:548",
      "removeCallsite": "e2e/utils/automator.ts:558"
    },
    "event": "exception",
    "messageField": "message",
    "subscribeCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:35",
    "assertCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:73",
    "closeCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:43",
    "helperSha256": "08a130c2ca3fde68edbc588b867bbcb710013015676a35100923b97874e0d832",
    "interval": "successful source on registration through successful source close",
    "maxEvents": 256,
    "maxMessageBytes": 65536
  },
  "plans": [
    {
      "ordinal": 0,
      "fullName": "issue #1182 production mount identity preserves the production instance and original reactive binding after repeated replacement mounts",
      "route": "pages/index/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "query": "css",
            "selector": "#mount-value",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-setups",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-identity",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 0,
          "method": "incrementOriginal",
          "args": [],
          "sourceCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:61",
          "helperSha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "incremented",
          "queries": [
            {
              "query": "css",
            "selector": "#mount-value",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-setups",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-identity",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 1,
          "method": "replaceMount",
          "args": [],
          "sourceCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:63",
          "helperSha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "replaced",
          "queries": [
            {
              "query": "css",
            "selector": "#mount-value",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-setups",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-identity",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 2,
          "method": "incrementOriginal",
          "args": [],
          "sourceCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:65",
          "helperSha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 3,
          "id": "original-active",
          "queries": [
            {
              "query": "css",
            "selector": "#mount-value",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-setups",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-identity",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 3,
          "method": "incrementReplacement",
          "args": [],
          "sourceCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:67",
          "helperSha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 4,
          "id": "replacement-inactive",
          "queries": [
            {
              "query": "css",
            "selector": "#mount-value",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-setups",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-identity",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 4,
          "method": "replaceMount",
          "args": [],
          "sourceCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:69",
          "helperSha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 5,
          "id": "repeated",
          "queries": [
            {
              "query": "css",
            "selector": "#mount-value",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-setups",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-identity",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "reLaunch",
          "ordinal": 5,
          "route": "pages/index/index",
          "sourceCallsite": "e2e/ide/issue-1182-production-mount.runtime.test.ts:71",
          "sourceAcquisition": "MiniProgram.reLaunch then actual new Page"
        },
        {
          "kind": "checkpoint",
          "ordinal": 6,
          "id": "reopened",
          "queries": [
            {
              "query": "css",
            "selector": "#mount-value",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-setups",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "query": "css",
            "selector": "#mount-identity",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        }
      ]
    }
  ]
})
