const freeze=value=>{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value)};return value}
export const descriptor=freeze({
  "schemaVersion": 1,
  "caseId": "ide-github-issues-runtime-issue1011",
  "caseSourcePath": "e2e/ide/github-issues.runtime.issue1011.test.ts",
  "sourceSha256": "d7dacedd9dc11c244ec49ef22491829d1b316d2f1ad8b72f574be6408c55fdfa",
  "sourceGuards": [
    {
      "path": "e2e/ide/github-issues.runtime.issue1011.test.ts",
      "bytes": 4244,
      "sha256": "d7dacedd9dc11c244ec49ef22491829d1b316d2f1ad8b72f574be6408c55fdfa"
    },
    {
      "path": "e2e-apps/github-issues/src/pages/issue-1011/index.vue",
      "bytes": 2378,
      "sha256": "274ef53f78357e3b9d3df437cfe31184ba7b785b184fdfc92e347b30edf6a27d"
    },
    {
      "path": "e2e/ide/github-issues.runtime.shared.ts",
      "sha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb",
      "bytes": 53026
    },
    {
      "path": "packages/miniprogram-automator/src/Page.ts",
      "sha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
      "bytes": 39463
    },
    {
      "path": "packages/miniprogram-automator/src/Element.ts",
      "sha256": "6dc33bcfff5044ce57f880b5f76ca5d1320e0980ece33537286fe604d6691d49",
      "bytes": 15890
    },
    {
      "path": "e2e/utils/domAcceptance/index.ts",
      "sha256": "8d411a4c2f4ac0dd7f49fc6f53d652a4accaadae6311058a73bb9b0f09f64e1e",
      "bytes": 3812
    },
    {
      "path": "e2e/utils/domAcceptance/checkpoint.ts",
      "sha256": "cd4650865c18dd0095da564e2dd68c520b4ec244ca8865b120d47ea2a0b00fdb",
      "bytes": 11561
    },
    {
      "path": "e2e/utils/domAcceptance/query.ts",
      "sha256": "2f7ba046364a7c94b1de8b99b40b02e9bef90426a4d2a617a8749fbfff07efa0",
      "bytes": 823
    },
    {
      "path": "e2e/vitest.e2e.devtools.config.ts",
      "sha256": "b0f2df586b608675855ed926f12f125c3e615cdd9ecdd4c9fa76d74120a60724",
      "bytes": 1730
    },
    {
      "path": "e2e/vitest.e2e.ide.setup.ts",
      "sha256": "6c7e965a0fbe17c6a5354f41951691b29215462d0572b57680fa604b2f1c33a8",
      "bytes": 1498
    },
    {
      "path": "e2e/vitest.e2e.dom.setup.ts",
      "sha256": "31907a9736228bb726bddb6374708f0c77a23df33e92015b56ae08c07c334ceb",
      "bytes": 558
    },
    {
      "path": "pnpm-lock.yaml",
      "sha256": "3835ebbb9cb5c990fb0856dbf5e209e9a2f223bc4c5b9365bc01914c75bb10b1",
      "bytes": 1107626
    },
    {
      "path": "package.json",
      "sha256": "7a4743eb60dd1219f6fd238ccf5cac99b6043d287f8ff136643920c73abbe31b",
      "bytes": 30733
    }
  ],
  "pageRootReadiness": {
    "selector": "#issue-1011-page",
    "timeoutMs": 5000,
    "sourceCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:76",
    "helperSha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685"
  },
  "compiledFiles": [
    "pages/issue-1011/index.js",
    "pages/issue-1011/index.json",
    "pages/issue-1011/index.wxml",
    "app.json"
  ],
  "staticObligations": {
    "pathExistsCount": 3,
    "appPagesIncludes": "pages/issue-1011/index"
  },
  "nativeNodeInput": {
    "kind": "accepted-frame-node-input-v1",
    "enabled": true
  },
  "plans": [
    {
      "ordinal": 0,
      "fullName": "e2e app: github-issues / issue #1011 keeps destructuring semantics equal between rendered and event values",
      "route": "pages/issue-1011/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": "#issue1011-value-missing",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue1011-value-null",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue1011-value-zero",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue1011-value-false",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue1011-tuple-0",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue1011-capture-count",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "tap",
          "ordinal": 0,
          "address": {
            "selector": "#issue1011-action-missing",
            "query": "css"
          },
          "queryMethod": "$",
          "sourceAcquisition": "tapElement Page.$ default and actual fallback sequence",
          "sourceCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:84",
          "sourceIteration": 0,
          "helper": {
            "path": "e2e/ide/github-issues.runtime.shared.ts",
            "sha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb",
            "functionName": "tapElement",
            "functionSha256": "d51ed77dbe6352e24d067d1ed6bd2a874ac628e656b3e2a6622229f92822076c",
            "startLine": 1617,
            "endLine": 1655,
            "queryArguments": 1,
            "waitMs": 240,
            "modes": [
              "tap",
              "trigger",
              "touch",
              "dispatch"
            ]
          }
        },
        {
          "kind": "tap",
          "ordinal": 1,
          "address": {
            "selector": "#issue1011-action-null",
            "query": "css"
          },
          "queryMethod": "$",
          "sourceAcquisition": "tapElement Page.$ default and actual fallback sequence",
          "sourceCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:84",
          "sourceIteration": 1,
          "helper": {
            "path": "e2e/ide/github-issues.runtime.shared.ts",
            "sha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb",
            "functionName": "tapElement",
            "functionSha256": "d51ed77dbe6352e24d067d1ed6bd2a874ac628e656b3e2a6622229f92822076c",
            "startLine": 1617,
            "endLine": 1655,
            "queryArguments": 1,
            "waitMs": 240,
            "modes": [
              "tap",
              "trigger",
              "touch",
              "dispatch"
            ]
          }
        },
        {
          "kind": "tap",
          "ordinal": 2,
          "address": {
            "selector": "#issue1011-action-zero",
            "query": "css"
          },
          "queryMethod": "$",
          "sourceAcquisition": "tapElement Page.$ default and actual fallback sequence",
          "sourceCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:84",
          "sourceIteration": 2,
          "helper": {
            "path": "e2e/ide/github-issues.runtime.shared.ts",
            "sha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb",
            "functionName": "tapElement",
            "functionSha256": "d51ed77dbe6352e24d067d1ed6bd2a874ac628e656b3e2a6622229f92822076c",
            "startLine": 1617,
            "endLine": 1655,
            "queryArguments": 1,
            "waitMs": 240,
            "modes": [
              "tap",
              "trigger",
              "touch",
              "dispatch"
            ]
          }
        },
        {
          "kind": "tap",
          "ordinal": 3,
          "address": {
            "selector": "#issue1011-action-false",
            "query": "css"
          },
          "queryMethod": "$",
          "sourceAcquisition": "tapElement Page.$ default and actual fallback sequence",
          "sourceCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:84",
          "sourceIteration": 3,
          "helper": {
            "path": "e2e/ide/github-issues.runtime.shared.ts",
            "sha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb",
            "functionName": "tapElement",
            "functionSha256": "d51ed77dbe6352e24d067d1ed6bd2a874ac628e656b3e2a6622229f92822076c",
            "startLine": 1617,
            "endLine": 1655,
            "queryArguments": 1,
            "waitMs": 240,
            "modes": [
              "tap",
              "trigger",
              "touch",
              "dispatch"
            ]
          }
        },
        {
          "kind": "tap",
          "ordinal": 4,
          "address": {
            "selector": "#issue1011-tuple-0",
            "query": "css"
          },
          "queryMethod": "$",
          "sourceAcquisition": "tapElement Page.$ default and actual fallback sequence",
          "sourceCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:86",
          "sourceIteration": 4,
          "helper": {
            "path": "e2e/ide/github-issues.runtime.shared.ts",
            "sha256": "958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb",
            "functionName": "tapElement",
            "functionSha256": "d51ed77dbe6352e24d067d1ed6bd2a874ac628e656b3e2a6622229f92822076c",
            "startLine": 1617,
            "endLine": 1655,
            "queryArguments": 1,
            "waitMs": 240,
            "modes": [
              "tap",
              "trigger",
              "touch",
              "dispatch"
            ]
          }
        },
        {
          "kind": "method.poll",
          "ordinal": 5,
          "method": "_snapshot",
          "args": [],
          "callOptions": {
            "timeout": 5000
          },
          "sourceCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:89",
          "helperSha256": "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
          "sourceAcquisition": "Page.callMethodWithOptions inside original awaited expect.poll",
          "pollScopeCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:88",
          "pollAssertCallsite": "e2e/ide/github-issues.runtime.issue1011.test.ts:91",
          "pollSourceSha256": "d7dacedd9dc11c244ec49ef22491829d1b316d2f1ad8b72f574be6408c55fdfa",
          "timeoutMs": 10000,
          "intervalMs": 50,
          "intervalSource": "pinned Vitest default; actual worker must have no override",
          "matcher": "toEqual",
          "normalization": {
            "kind": "pinned-pure-read-terminal-v1",
            "sourcePath": "e2e-apps/github-issues/src/pages/issue-1011/index.vue",
            "sourceSha256": "274ef53f78357e3b9d3df437cfe31184ba7b785b184fdfc92e347b30edf6a27d",
            "methodBodySha256": "57d6456776991cc45c4cc7b75730cba4eeb9a2f369a00f83d15bef0c77d8e556",
            "methodStartLine": 55,
            "methodEndLine": 60,
            "methodAstStart": 1128,
            "methodAstEnd": 1303,
            "methodSyntaxKind": "FunctionDeclaration",
            "rawAttempts": "complete-private-journal"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "captured",
          "queries": [
            {
              "selector": "#issue1011-capture-count",
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
  ]
})
