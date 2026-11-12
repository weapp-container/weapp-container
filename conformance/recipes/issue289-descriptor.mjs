/** Exact source addresses, order and selected field names; no expected values/counts. */
export const descriptor = {
  "caseId": "ide-github-issues-runtime-issue289",
  "caseSourcePath": "e2e/ide/github-issues.runtime.issue289.test.ts",
  "sourceSha256": "eebdc8af20fa9f95c145520fd26914788bebfc46208adb2362797ac711c34c53",
  "plans": [
    {
      "ordinal": 0,
      "fullName": "e2e app: github-issues / issue-289 issue #289: compiles object-literal class bindings and runtime probe",
      "route": "pages/issue-289/object-literal/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": ".issue289-object-toggle-list",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue289-object-toggle-compact",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-item-active .object-item-label",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-list-loose .object-item",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-object-toggle-list",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "hidden",
          "queries": [
            {
              "selector": "#issue289-object-empty.object-empty-loose",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-item",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-object-toggle-list",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "restored",
          "queries": [
            {
              "selector": ".issue289-object-toggle-list",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-item",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
              "fields": {
                "text": false,
                "attributes": []
              }
            },
            {
              "selector": "#issue289-object-empty",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-object-toggle-compact",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 3,
          "id": "compact",
          "queries": [
            {
              "selector": ".issue289-object-toggle-compact",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-list-compact .object-item",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
              "fields": {
                "text": false,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "tap",
          "ordinal": 3,
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-object-cycle-active",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 4,
          "id": "active",
          "queries": [
            {
              "selector": ".issue289-object-cycle-active",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-item-active .object-item-label",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-item-badge-warning",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".object-item-idle",
              "query": "css",
              "scope": [
                "#issue289-object-example"
              ],
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
      "fullName": "e2e app: github-issues / issue-289 issue #289: compiles map-class dynamic class bindings and runtime probe",
      "route": "pages/issue-289/map-class/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": ".issue289-map-toggle-expanded.issue289-ctrl-on",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".event-chip-theme.event-chip-expanded",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".event-chip",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-map-toggle-expanded",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "collapsed",
          "queries": [
            {
              "selector": ".issue289-map-toggle-expanded.issue289-ctrl-off",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".event-chip-theme.event-chip-collapsed",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".event-chip-collapsed",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-map-cycle-selected",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "selected",
          "queries": [
            {
              "selector": ".issue289-map-cycle-selected.issue289-cycle-0",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".event-chip-highlight",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".event-chip-theme",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-map-toggle-list",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 3,
          "id": "hidden",
          "queries": [
            {
              "selector": ".issue289-map-toggle-list.issue289-ctrl-off",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".map-meta-empty",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".event-chip",
              "query": "css",
              "scope": [
                {
                  "has": ".issue289-map-mock"
                }
              ],
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
      "fullName": "e2e app: github-issues / issue-289 issue #289: compiles root-class bindings and runtime probe",
      "route": "pages/issue-289/root-class/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": "#issue289-root-class-value.aaaa",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".root-option-active",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".root-option",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-root-cycle-option",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "selected",
          "queries": [
            {
              "selector": ".issue289-root-cycle-option",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue289-root-class-value.bbbb",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".root-option-active",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "tap",
          "ordinal": 1,
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-root-toggle-options",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "hidden",
          "queries": [
            {
              "selector": "#issue289-root-class-value.bbbb",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".root-options-tip",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".root-option",
              "query": "css",
              "scope": [
                {
                  "has": ".root-class-box"
                }
              ],
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
      "ordinal": 3,
      "fullName": "e2e app: github-issues / issue-289 issue #289: compiles computed-class dynamic class bindings and runtime probe",
      "route": "pages/issue-289/computed-class/index",
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": "#issue289-computed-main.a",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".computed-item-active",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".computed-list-enabled .computed-item",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-computed-toggle-source",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 1,
          "id": "source",
          "queries": [
            {
              "selector": ".issue289-computed-toggle-source.issue289-ctrl-off",
              "query": "css",
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": "#issue289-computed-main.b",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".computed-item-match",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            }
          ]
        },
        {
          "kind": "tap",
          "ordinal": 1,
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-computed-cycle-selected",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 2,
          "id": "selected",
          "queries": [
            {
              "selector": ".computed-item-active.computed-item-match",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".computed-item-idle",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
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
          "sourceAcquisition": "Page.$$ then unique Element.tap",
          "address": {
            "selector": ".issue289-computed-toggle-items",
            "query": "css"
          }
        },
        {
          "kind": "checkpoint",
          "ordinal": 3,
          "id": "hidden",
          "queries": [
            {
              "selector": ".computed-empty-b",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".computed-item",
              "query": "css",
              "scope": [
                {
                  "has": ".computed-class-box"
                }
              ],
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
    "pages/issue-289/object-literal/index.wxml",
    "pages/issue-289/object-literal/index.js",
    "pages/issue-289/map-class/index.wxml",
    "pages/issue-289/map-class/index.js",
    "pages/issue-289/root-class/index.wxml",
    "pages/issue-289/root-class/index.js",
    "pages/issue-289/computed-class/index.wxml",
    "pages/issue-289/computed-class/index.js"
  ]
}
