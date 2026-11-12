/** 只记录原始源码身份、地址和调用顺序；预期内容单独保留在断言模块。 */
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
const sourceGuards = [
  {"path":"e2e/ide/github-issues.runtime.issue1009.test.ts","sha256":"7aab6c9ec6c09f610bd8c13ae834dd63d96f906d40b2a5f86448a1f114bf56e9","bytes":3728},
  {"path":"e2e/ide/github-issues.runtime.shared.ts","sha256":"958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb","bytes":53026},
  {"path":"e2e-apps/github-issues/src/pages/issue-1009/index.vue","sha256":"d6abb287b7b347a67b0c65c1b5210c59499943db9ba1e68f7d6751c60449114d","bytes":2391},
  {"path":"packages/miniprogram-automator/src/Page.ts","sha256":"0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685","bytes":39463},
  {"path":"packages/miniprogram-automator/src/Element.ts","sha256":"6dc33bcfff5044ce57f880b5f76ca5d1320e0980ece33537286fe604d6691d49","bytes":15890},
  {"path":"e2e/utils/domAcceptance/index.ts","sha256":"8d411a4c2f4ac0dd7f49fc6f53d652a4accaadae6311058a73bb9b0f09f64e1e","bytes":3812},
  {"path":"e2e/utils/domAcceptance/checkpoint.ts","sha256":"cd4650865c18dd0095da564e2dd68c520b4ec244ca8865b120d47ea2a0b00fdb","bytes":11561},
  {"path":"e2e/utils/domAcceptance/query.ts","sha256":"2f7ba046364a7c94b1de8b99b40b02e9bef90426a4d2a617a8749fbfff07efa0","bytes":823},
  {"path":"e2e/vitest.e2e.devtools.config.ts","sha256":"b0f2df586b608675855ed926f12f125c3e615cdd9ecdd4c9fa76d74120a60724","bytes":1730},
  {"path":"e2e/vitest.e2e.ide.setup.ts","sha256":"6c7e965a0fbe17c6a5354f41951691b29215462d0572b57680fa604b2f1c33a8","bytes":1498},
  {"path":"e2e/vitest.e2e.dom.setup.ts","sha256":"31907a9736228bb726bddb6374708f0c77a23df33e92015b56ae08c07c334ceb","bytes":558},
  {"path":"pnpm-lock.yaml","sha256":"3835ebbb9cb5c990fb0856dbf5e209e9a2f223bc4c5b9365bc01914c75bb10b1","bytes":1107626},
  {"path":"package.json","sha256":"7a4743eb60dd1219f6fd238ccf5cac99b6043d287f8ff136643920c73abbe31b","bytes":30733},
]
const resultSelectors = ["#issue1009-result-ctx","#issue1009-result-scope","#issue1009-result-bindings","#issue1009-result-nested","#issue1009-result-event","#issue1009-result-control"]
const resultQueries = () => resultSelectors.map(selector => ({ selector, query: 'css', fields: { text: true, attributes: [] } }))
const actionSelectors = ["#issue1009-ctx-callback","#issue1009-scope-callback","#issue1009-component-bindings","#issue1009-nested-callbacks","#issue1009-event-boundary","#issue1009-control"]
export const descriptor = freeze({
  "schemaVersion": 1,
  "caseId": "ide-github-issues-runtime-issue1009",
  "caseSourcePath": "e2e/ide/github-issues.runtime.issue1009.test.ts",
  "sourceSha256": "7aab6c9ec6c09f610bd8c13ae834dd63d96f906d40b2a5f86448a1f114bf56e9",
  "compiledFiles": ["pages/issue-1009/index.js","pages/issue-1009/index.json","pages/issue-1009/index.wxml"],
  "navigation": {"sourceCallsite":"e2e/ide/github-issues.runtime.issue1009.test.ts:71","helper":"relaunchPage","helperSha256":"958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb","timeoutMs":45000,"readiness":{"sourceCallsite":"e2e/ide/github-issues.runtime.issue1009.test.ts:73","method":"waitForRendered","selector":"#issue-1009-page","timeoutMs":5000,"returns":true}},
  "cleanup": {"releaseCallsite":"e2e/ide/github-issues.runtime.issue1009.test.ts:100","suiteCloseCallsite":"e2e/ide/github-issues.runtime.issue1009.test.ts:39"},
  sourceGuards,
  plans: [{
    ordinal: 0,
    fullName: "e2e app: github-issues / issue #1009 keeps compiler-owned handler parameters isolated from user bindings",
    route: "pages/issue-1009/index",
    steps: [
      { kind: 'checkpoint', ordinal: 0, id: 'initial', queries: [
        {"selector":"#issue-1009-page","query":"css","fields":{"text":false,"attributes":["data-e2e-issue"]}}, ...resultQueries(),
      ] },
      ...actionSelectors.map((selector, ordinal) => ({
        kind: 'tap', ordinal, address: { selector, query: 'css' },
        sourceAcquisition: "Page.$ then actual Element.tap",
        queryMethod: "$",
        queryOptions: {"timeout":2000},
        sourceCallsite: "e2e/ide/github-issues.runtime.issue1009.test.ts:88",
        tapCallsite: "e2e/ide/github-issues.runtime.issue1009.test.ts:90",
        pageHelperSha256: "0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685",
        elementHelperSha256: "6dc33bcfff5044ce57f880b5f76ca5d1320e0980ece33537286fe604d6691d49",
        sourceIteration: ordinal,
      })),
      {"kind":"method.poll","normalization":{"kind":"pinned-pure-read-terminal-v1","sourcePath":"e2e-apps/github-issues/src/pages/issue-1009/index.vue","sourceSha256":"d6abb287b7b347a67b0c65c1b5210c59499943db9ba1e68f7d6751c60449114d","methodBodySha256":"a05fabee9f3f98ec730ff6e33bf43159fc61a4b6d7cede87885cb3a34328ae67","methodStartLine":28,"methodEndLine":30,"rawAttempts":"complete-private-journal"},"ordinal":6,"method":"_runE2E","args":[],"sourceCallsite":"e2e/ide/github-issues.runtime.issue1009.test.ts:94","helperSha256":"0b9d1b77fccfae165ac29720001eb949e21492388b5a2124051e157d31266685","sourceAcquisition":"Page.callMethod inside original awaited expect.poll","pollScopeCallsite":"e2e/ide/github-issues.runtime.issue1009.test.ts:93","pollAssertCallsite":"e2e/ide/github-issues.runtime.issue1009.test.ts:96","pollSourceSha256":"7aab6c9ec6c09f610bd8c13ae834dd63d96f906d40b2a5f86448a1f114bf56e9","timeoutMs":10000,"intervalMs":50,"intervalSource":"pinned Vitest default; actual worker must have no override","matcher":"toEqual"},
      { kind: 'checkpoint', ordinal: 1, id: 'completed', queries: resultQueries() },
    ],
  }],
})
