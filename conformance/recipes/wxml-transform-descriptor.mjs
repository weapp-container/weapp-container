/** Structure and source-operation coverage only; no expected rendered values. */
export const descriptor = Object.freeze({
  sourceSha256: '697e7f72f545f1c8df358930c5ecca297d8888bb16f0cf01a4bc88084392d4a2',
  routes: ['pages/native/index', 'pages/vue/index'],
  checkpoints: [
    { id: 'transformed', selectors: ['view#renamed', '#retained'] },
    { id: 'event', selectors: ['#result'] },
  ],
  direct: [
    { op: 'query', selector: 'view#renamed' },
    { op: 'attribute', selector: 'view#renamed', name: 'data-literal' },
    { op: 'attribute', selector: 'view#renamed', name: 'data-number' },
    { op: 'attribute', selector: 'view#renamed', name: 'data-bool' },
    { op: 'attribute', selector: 'view#renamed', name: 'data-expression' },
    { op: 'query', selector: '#retained' },
    { op: 'attribute', selector: '#retained', name: 'data-testid' },
    { op: 'attribute', selector: '#retained', name: 'data-direct-child' },
    { op: 'query', selector: 'view#nested-child' },
    { op: 'text', selector: 'view#nested-child' },
    { op: 'attribute', selector: 'view#nested-child', name: 'data-subtree-visited' },
    { op: 'query', selector: '[data-remove-subtree]' },
    { op: 'query', selector: '#tap' },
    { op: 'tap', selector: '#tap' },
  ],
  compiledFiles: ['pages/native/index.js', 'pages/native/index.json', 'pages/native/index.wxml',
    'pages/vue/index.js', 'pages/vue/index.json', 'pages/vue/index.wxml'],
})
