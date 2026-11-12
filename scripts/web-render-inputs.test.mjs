import assert from 'node:assert/strict'
import test from 'node:test'
import { routeStyleIds } from '../examples/hosts/web-wasm/render-inputs.mjs'

test('route rendering retains recursive and app-wide component styles without another page stylesheet', () => {
  const manifest = {
    app: { appJson: 'app.json' },
    components: [
      { owner: 'app.json', usingComponents: { shared: 'components/shared' } },
      { owner: 'pages/home.json', usingComponents: { counter: 'components/counter' } },
      { owner: 'components/counter.json', usingComponents: { label: 'components/label' } },
      { owner: 'components/label.json', usingComponents: { counter: 'components/counter' } },
      { owner: 'pages/other.json', usingComponents: { unrelated: 'components/unrelated' } },
    ],
    styles: [
      ['app', 'app'], ['pages/home', 'page'], ['pages/other', 'page'],
      ['components/shared', 'component'], ['components/counter', 'component'],
      ['components/label', 'component'], ['components/unrelated', 'component'],
    ].map(([path, scope]) => ({ id: `style:${path}.wxss`, scope })),
  }
  assert.deepEqual(routeStyleIds(manifest, { path: 'pages/home' }), [
    'style:app.wxss', 'style:pages/home.wxss', 'style:components/shared.wxss',
    'style:components/counter.wxss', 'style:components/label.wxss',
  ])
  assert.deepEqual(routeStyleIds(manifest, { path: 'pages/other', config: 'pages/other.json' }), [
    'style:app.wxss', 'style:pages/other.wxss', 'style:components/shared.wxss', 'style:components/unrelated.wxss',
  ])
})

test('unnormalized component targets cannot select another route or external stylesheet', () => {
  for (const target of ['../other', '/absolute', null, '']) {
    assert.throws(() => routeStyleIds({ app: { appJson: 'app.json' }, styles: [],
      components: [{ owner: 'app.json', usingComponents: { child: target } }] }, { path: 'home' }), /ERR_INVALID_MANIFEST/)
  }
})
