/** Source addresses, names and exact original/helper identities only; no expected rendered values. */
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }; return value }
export const descriptor = freeze({
  "caseId": "ide-github-issues-runtime-issue297-302",
  "caseSourcePath": "e2e/ide/github-issues.runtime.issue297-302.test.ts",
  "sourceSha256": "aee42467cd56a31d550bc4e345c6691b3651d47b12efcdf860945854227fc2a6",
  "sourceGuards": [
    {
      "path": "e2e/ide/github-issues.runtime.issue297-302.test.ts",
      "sha256": "aee42467cd56a31d550bc4e345c6691b3651d47b12efcdf860945854227fc2a6",
      "bytes": 5825
    },
    {
      "path": "e2e/ide/githubIssuesDom/expressions.ts",
      "sha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
      "bytes": 4267
    },
    {
      "path": "e2e/ide/githubIssuesDom/index.ts",
      "sha256": "f2cf1271b9a5a0aca636c5f1a52ef8782d08c87fb2ff5ba59b0740142481f544",
      "bytes": 1327
    }
  ],
  "plans": [
    {
      "ordinal": 0,
      "fullName": "e2e app: github-issues / issue-297-302 issue #297: compiles complex call expressions",
      "route": "pages/issue-297/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": ".issue297-bind .issue297-case-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297-row-0 .issue297-row-text",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297-row-1 .issue297-row-text",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297-row",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 0,
          "method": "cycleActive",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:11 CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "active",
          "queries": [
            {
              "selector": "#issue297-active-label",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297-active-meta",
              "query": "css",
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
          "method": "appendRow",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:15 CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "appended",
          "queries": [
            {
              "selector": "#issue297-row-2 .issue297-row-text",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297-row-2 .issue297-row-subtext",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297-row",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 2,
          "method": "toggleListCase",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:20 CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 3,
          "id": "hidden",
          "queries": [
            {
              "selector": ".issue297-empty-text",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297-row",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 3,
          "method": "toggleListCase",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:24 CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 4,
          "id": "restored",
          "queries": [
            {
              "selector": "#issue297-row-2 .issue297-row-text",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297-empty",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            },
            {
              "selector": ".issue297-row",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 4,
          "method": "resetRows",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:29 CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 5,
          "id": "reset",
          "queries": [
            {
              "selector": "#issue297-active-label",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297-row",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            },
            {
              "selector": "#issue297-row-2",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        }
      ]
    },
    {
      "ordinal": 1,
      "fullName": "e2e app: github-issues / issue-297-302 issue #297: setup method call variants remain stable across expression contexts",
      "route": "pages/issue-297-setup-method-calls/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": ".issue297m-inline-anchor",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297m-bind .issue297m-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-row-0",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-row-1",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-member-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-template-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-wrap-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-optional-result",
              "query": "css",
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
          "method": "cycleActive",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:47 SETUP_CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "active",
          "queries": [
            {
              "selector": ".issue297m-bind .issue297m-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-member-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-wrap-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-optional-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue297m-ternary-result",
              "query": "css",
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
          "method": "toggleOptionalInvoker",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:54 SETUP_CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "optional-disabled",
          "queries": [
            {
              "selector": "#issue297m-optional-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297m-bind .issue297m-result",
              "query": "css",
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
          "method": "toggleShowCase",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:58 SETUP_CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 3,
          "id": "case-hidden",
          "queries": [
            {
              "selector": "#issue297m-ternary-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297m-inline-anchor",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "method.call",
          "ordinal": 3,
          "method": "toggleShowLoop",
          "args": [],
          "sourceCallsite": "e2e/ide/githubIssuesDom/expressions.ts:62 SETUP_CALL_EXPRESSIONS",
          "helperSha256": "1ddc38ffb64a2c156f64a3d122e1d37fa3dfbdc0065369a5bec0b3b676b8de3c",
          "sourceAcquisition": "Page.callMethod then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 4,
          "id": "loop-hidden",
          "queries": [
            {
              "selector": ".issue297m-loop-empty .issue297m-result",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue297m-loop-row",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        }
      ]
    },
    {
      "ordinal": 2,
      "fullName": "e2e app: github-issues / issue-297-302 issue #302: compiles v-for class bindings with active state updates",
      "route": "pages/issue-302/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": ".issue302-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-a.issue302-item-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-inactive",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "tap",
          "ordinal": 0,
          "address": {
            "selector": ".issue302-item-b",
            "query": "css"
          },
          "sourceAcquisition": "Page.$$ then unique Element.tap"
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "active-b",
          "queries": [
            {
              "selector": ".issue302-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-b.issue302-item-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-inactive",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "tap",
          "ordinal": 1,
          "address": {
            "selector": ".issue302-item-c",
            "query": "css"
          },
          "sourceAcquisition": "Page.$$ then unique Element.tap"
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "active-c",
          "queries": [
            {
              "selector": ".issue302-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-c.issue302-item-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-inactive",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "tap",
          "ordinal": 2,
          "address": {
            "selector": ".issue302-item-a",
            "query": "css"
          },
          "sourceAcquisition": "Page.$$ then unique Element.tap"
        },
        {
          "kind": "checkpoint",
          "ordinal": 3,
          "id": "active-a",
          "queries": [
            {
              "selector": ".issue302-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-a.issue302-item-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue302-item-inactive",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        }
      ]
    }
  ],
  "compiledFiles": [
    "pages/issue-297/index.wxml",
    "pages/issue-297/index.js",
    "pages/issue-297-setup-method-calls/index.wxml",
    "pages/issue-297-setup-method-calls/index.js",
    "pages/issue-302/index.wxml",
    "pages/issue-302/index.js"
  ]
})
