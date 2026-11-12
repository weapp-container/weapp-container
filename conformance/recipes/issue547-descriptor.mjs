/** Exact source addresses, order and selected field names; no expected values/counts. */
export const descriptor = {
  "caseId": "ide-github-issues-runtime-issue547",
  "caseSourcePath": "e2e/ide/github-issues.runtime.issue547.test.ts",
  "sourceSha256": "46bd53dda261261a5a9cd5e1e3fc89e07a8fd7660e0fcbbe3e8bdd73499f3f11",
  "plans": [
    {
      "ordinal": 0,
      "fullName": "e2e app: github-issues / issue #547 renders nested augmented default slot content in DevTools",
      "route": "pages/issue-547/index",
      "readiness": {
        "selector": "#issue547-page",
        "attributes": [
          "data-e2e-issue"
        ]
      },
      "steps": [
        {
          "kind": "checkpoint",
          "ordinal": 0,
          "id": "initial",
          "queries": [
            {
              "selector": ".issue547-group__title",
              "query": "css",
              "scope": [
                "#issue547-group"
              ],
              "fields": {
                "text": true,
                "attributes": []
              }
            },
            {
              "selector": ".issue547-image",
              "query": "css",
              "scope": [
                "#issue547-group",
                {
                  "has": "#issue547-cell"
                },
                "#issue547-cell",
                {
                  "has": "#issue547-image"
                },
                "#issue547-image"
              ],
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
    "pages/issue-547/index.wxml",
    "components/issue-547/NestedSlotImage/index.wxml"
  ]
}
