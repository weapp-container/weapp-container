/** Original source addresses/options only; no expected value drives execution. */
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)};return value}
export const descriptor=freeze({
  "caseId": "ide-github-issues-runtime-issue941",
  "caseSourcePath": "e2e/ide/github-issues.runtime.issue941.test.ts",
  "sourceSha256": "8789b12749c7c6e96a6a8e96bb70b058dddeffca771c83b1952eb2159ffb3405",
  "sourceGuards": [
    {
      "path": "e2e/ide/github-issues.runtime.issue941.test.ts",
      "sha256": "8789b12749c7c6e96a6a8e96bb70b058dddeffca771c83b1952eb2159ffb3405",
      "bytes": 3759
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
      "fullName": "e2e app: github-issues / issue #941 keeps every wx direct-return API out of the Promise bridge",
      "route": "pages/issue-941/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": "#issue941-title",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-cache-options",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue941-result",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            },
            {
              "selector": ".issue941-void",
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
          "method": "_runE2E",
          "args": [],
          "callOptions": {
            "timeout": 8000
          },
          "sourceCallsite": "e2e/ide/github-issues.runtime.issue941.test.ts:89 callMethodWithOptions",
          "helperSha256": "8789b12749c7c6e96a6a8e96bb70b058dddeffca771c83b1952eb2159ffb3405",
          "sourceAcquisition": "Page.callMethodWithOptions then awaited terminal completion"
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "executed",
          "queries": [
            {
              "selector": "#issue941-checkIsPictureInPictureActive",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-createBufferURL",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-createCacheManager",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-createGlobalPayment",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-createInferenceSession",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-createVideoDecoder",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-getApiCategory",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-getAppAuthorizeSetting",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-getAppBaseInfo",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-getDeviceInfo",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-getPluginUpdateManager",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-getSystemSetting",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-getWindowInfo",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-isVKSupport",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-postMessageToReferrerMiniProgram",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-postMessageToReferrerPage",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-reportEvent",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-reportMonitor",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-reportPerformance",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-requestAppleSubscribeSign",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-revokeBufferURL",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue941-result",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            },
            {
              "selector": ".issue941-void",
              "query": "css",
              "fields": {
                "text": false,
                "attributes": []
              }
            },
            {
              "selector": "#issue941-cache-options",
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
    "pages/issue-941/index.js",
    "pages/issue-941/index.json",
    "pages/issue-941/index.wxml"
  ]
})
