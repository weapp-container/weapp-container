import { replayIssue1011 } from './issue1011-replay.mjs'
import { createCollector as issue1011Collector } from '../../../conformance/recipes/issue1011-collector.mjs'
import { replayIssue941 } from './issue941-replay.mjs'
import { createCollector as issue941Collector } from '../../../conformance/recipes/issue941-collector.mjs'
import { replayIssue1009 } from './issue1009-replay.mjs'
import { createCollector as issue1009Collector } from '../../../conformance/recipes/issue1009-collector.mjs'
import {replayIssue826} from './issue826-replay.mjs'
import {createCollector as issue826Collector} from '../../../conformance/recipes/issue826-collector.mjs'
import { replayIssue1008 } from './issue1008-replay.mjs'
import { createCollector as issue1008Collector } from '../../../conformance/recipes/issue1008-collector.mjs'
import { replayImportMeta } from './import-meta-replay.mjs'
import { createCollector as importMetaCollector } from '../../../conformance/recipes/import-meta-collector.mjs'
import { replayIssue1182 } from './issue1182-replay.mjs'
import { createCollector as issue1182Collector } from '../../../conformance/recipes/issue1182-collector.mjs'
import { replayIssue297302 } from './issue297-302-replay.mjs'
import { createCollector as issue297302Collector } from '../../../conformance/recipes/issue297-302-collector.mjs'
import { uniqueCollectorInputs } from './collector-inputs.mjs'
import { templateSfcCollectorDependencies } from './template-sfc-format-inputs.mjs'
import { replayTemplate as replayTemplateSfc } from './template-multi-platform-sfc-replay.mjs'
import { createCollector as templateSfcCollector } from '../../../conformance/recipes/template-multi-platform-sfc-collector.mjs'
import { templateCollectorDependencies } from './template-format-inputs.mjs'
import { replayTemplate } from './template-multi-platform-replay.mjs'
import { createCollector as templateCollector } from '../../../conformance/recipes/template-multi-platform-collector.mjs'
/** Reviewed case actions run against the real native IPC adapter. Expected
 * strings are assertions only; collectors receive actual reads/checkpoints. */
import { setTimeout as delay } from 'node:timers/promises'
import { createCollector as wxmlCollector } from '../../../conformance/recipes/wxml-transform-collector.mjs'
import { replayWxml } from './wxml-replay.mjs'
import { replaySubpackage } from './subpackage-replay.mjs'
import { replayComponentScopeFamily } from './component-scope-family-replay.mjs'
import { createCollector as issue547Collector } from '../../../conformance/recipes/issue547-collector.mjs'
import { createCollector as issue289Collector } from '../../../conformance/recipes/issue289-collector.mjs'
import { replayWebRuntime } from './web-runtime-replay.mjs'
import { createCollector as webRuntimeCollector } from '../../../conformance/recipes/web-runtime-collector.mjs'
import { replayIssue1013 } from './issue1013-replay.mjs'
import { createCollector as issue1013Collector } from '../../../conformance/recipes/issue1013-collector.mjs'
import { createCollector as itemCollector } from '../../../conformance/recipes/subpackage-item-collector.mjs'
import { createCollector as userCollector } from '../../../conformance/recipes/subpackage-user-collector.mjs'
import { createCollector as issue1058Collector } from '../../../conformance/recipes/issue1058-collector.mjs'
import { createCollector as issue1185Collector } from '../../../conformance/recipes/issue1185-collector.mjs'
import { createCollector as issue1072Collector } from '../../../conformance/recipes/issue1072-collector.mjs'
import { createCollector as issue1012Collector } from '../../../conformance/recipes/issue1012-collector.mjs'

import { createCollector as issue1034Collector } from '../../../conformance/recipes/issue1034-collector.mjs'
import { createCollector as issue1014Collector } from '../../../conformance/recipes/issue1014-collector.mjs'

const require = (condition, message) => { if (!condition) throw new Error(message) }
const scopeOf = value => value === undefined ? [] : value
const sameScope = (left, right) => Array.isArray(left) && left.length === right.length
  && right.every((part, index) => typeof left[index] === 'string' && left[index] === part)
const routeOf = value => {
  require(typeof value === 'string' && value.trim() === value && !/[\\?#]/.test(value), 'Native Page has no canonical actual route')
  const route = value.replace(/^\/+|\/+$/g, '')
  require(route && route.split('/').every(part => part && part !== '.' && part !== '..'), 'Native Page has no canonical actual route')
  return route
}

export function assertCheckpoint(evidence, expected) {
  require(evidence && Array.isArray(evidence.nodes) && evidence.nodes.length === expected.length, 'Actual checkpoint selector coverage differs')
  for (let at = 0; at < expected.length; at++) {
    const group = evidence.nodes[at], entry = expected[at]
    require(group && group.selector === entry.selector && group.query === 'css' && group.has === undefined
      && sameScope(scopeOf(group.scope), entry.scope ?? []) && group.count === (entry.count ?? 1)
      && Array.isArray(group.nodes) && group.nodes.length === group.count,
    `Actual rendered count, query or scope differs for ${entry.selector}`)
    if (entry.text !== undefined) require(group.nodes.length === 1 && group.nodes[0]?.text === entry.text,
      `Actual rendered text differs for ${entry.selector}: ${JSON.stringify(group.nodes)}`)
    for (const [name, value] of Object.entries(entry.attributes ?? {})) {
      require(group.nodes.length === 1 && group.nodes[0]?.attributes && Object.hasOwn(group.nodes[0].attributes, name)
        && group.nodes[0].attributes[name] === value,
      `Actual rendered attribute ${name} differs for ${entry.selector}: ${JSON.stringify(group.nodes)}`)
    }
  }
}

function assertAddress(value, route, scope, selector) {
  require(value && value.route === route && value.selector === selector && sameScope(scopeOf(value.scope), scope),
    'Native operation returned another actual route, selector or component scope')
}

/** A query first resolves a real accepted-tree node. Nested Element.$ retains
 * each component selector; Rust resolves its concrete runtime scope token.
 * No selector is flattened and no expected text crosses the IPC boundary. */
export function createNativeProgram(request) {
  const queryElement = async (route, scope, selector) => {
    require(typeof selector === 'string' && selector, 'Native query needs a selector')
    const address = { route, ...(scope.length ? { scope: [...scope] } : {}), selector }
    const observed = await request('query', address)
    assertAddress(observed, route, scope, selector)
    require(Number.isSafeInteger(observed.count) && observed.count >= 0
      && Array.isArray(observed.nodes) && observed.nodes.length === observed.count, 'Native query has incomplete actual node evidence')
    if (observed.count === 0) return undefined
    require(observed.count === 1, 'Native action query requires exactly one actual rendered node')
    return {
      async $(childSelector) {
        require(typeof observed.nodes[0]?.componentScopeId === 'string' && observed.nodes[0].componentScopeId,
          'Native Element.$ requires an actual runtime component host')
        return queryElement(route, [...scope, selector], childSelector)
      },
      async text() {
        const value = await request('query.text', address)
        assertAddress(value, route, scope, selector)
        require(value.count === 1 && typeof value.text === 'string', 'Native text read has no actual rendered string')
        return value.text
      },
      async tap() {
        const value = await request('tap', address)
        assertAddress(value, route, scope, selector)
        require(value.inputTransport === 'native-host-coordinate-event', 'Native tap did not use the host coordinate input transport')
        return value
      },
    }
  }
  return { async reLaunch(requested) {
    const actual = await request('reLaunch', { route: requested })
    const route = routeOf(actual?.path)
    require(actual.path === route && route === routeOf(requested), 'Native reLaunch returned another actual Page route')
    return { path: actual.path, async $(selector) { return queryElement(actual.path, [], selector) } }
  } }
}

const cases = {
  'ide-issue-1058-template-tags-runtime': {
    sourceSha256: '00adf03eed85511cd47f33867ed6e1dc897ade9c043671ff6f05a361feb180ea',
    collectorSha256: '227ee8a5a4166fdada2c65cf25344f9bf64bf7cbe3853558bb854e1efe1ecdf5',
    collectorPath: '../../../conformance/recipes/issue1058-collector.mjs', createCollector: issue1058Collector,
    async replay({ program, check, assertion }) {
      let page = await program.reLaunch('/pages/home/index')
      const countNodes = count => [
        { selector: '#builtin', text: 'builtin' }, { selector: '#pascal', text: `pascal-${count}` },
        { selector: '#kebab', text: `kebab-${count}` }, { selector: '#duplicate', text: `duplicate-${count}` },
        { selector: '#increment', text: String(count) },
      ]
      await check('count-0', page, countNodes(0))
      await (await page.$('#increment')).tap()
      await check('count-1', page, countNodes(1))
      assertion('issue #1058 shared template tag analysis runtime renders both tag spellings and duplicates with reactive updates')
      page = await program.reLaunch('/pages/boundary/index')
      const branchNodes = visible => [
        { selector: '#lowercase', ...(visible ? { text: 'explicit-lowercase' } : { count: 0 }) },
        { selector: '#explicit-pascal', ...(visible ? { text: 'explicit-pascal' } : { count: 0 }) },
        { selector: '#toggle', text: visible ? 'visible' : 'hidden' },
      ]
      await check('branch-0', page, branchNodes(true))
      await (await page.$('#toggle')).tap()
      await check('branch-1', page, branchNodes(false))
      await (await page.$('#toggle')).tap()
      await check('branch-2', page, branchNodes(true))
      assertion('issue #1058 shared template tag analysis runtime preserves lowercase explicit imports through branch removal and restoration')
    },
  },
  'ide-issue-1185-sibling-entry-runtime': {
    sourceSha256: 'dbb715c07236a1226d8523624715608f951670d1a1ce9775497a108f86e8373f',
    collectorSha256: '4dc9d2d9510b01ae70e53d31053c9fb74d78fba94dc3b33d45ef91776a744970',
    collectorPath: '../../../conformance/recipes/issue1185-collector.mjs', createCollector: issue1185Collector,
    async replay({ program, check, assertion }) {
      let page = await program.reLaunch('/pages/component/index')
      const componentNodes = count => [
        { scope: ['#foo'], selector: '#foo-values', text: '1/2' },
        { scope: ['#foo'], selector: '#foo-increment', text: String(count) },
      ]
      await check('component-0', page, componentNodes(0))
      const foo = await page.$('#foo')
      require(foo, 'Actual component #foo is absent')
      const button = await foo.$('#foo-increment')
      require(button, 'Actual component button is absent')
      await button.tap()
      await check('component-1', page, componentNodes(1))
      assertion('issue #1185: Vue entries with sibling scripts renders and updates a component explicitly imported with its Vue extension')
      page = await program.reLaunch('/pages/bar/bar')
      const barNodes = count => [{ selector: '#bar-values', text: '1/2' }, { selector: '#bar-increment', text: String(count) }]
      await check('page-0', page, barNodes(0))
      await (await page.$('#bar-increment')).tap()
      await check('page-1', page, barNodes(1))
      assertion('issue #1185: Vue entries with sibling scripts renders and updates the selected Vue page with its same-named TS import')
      page = await program.reLaunch('/pages/unused/unused')
      await check('unused-sibling', page, [{ selector: '#unused-value', text: '7' }])
      assertion('issue #1185: Vue entries with sibling scripts ignores a same-named TS file that the Vue page does not import')
    },
  },
  'ide-issue-1072-json-context-runtime': {
    sourceSha256: '12ea7f6371de370e35eeabc069996a4206dcf1c047d8e5510b6dfe23f46521e0',
    collectorSha256: '4c5e1b133b895b1c3de6b17e93086d89329622db60476d79c34c6ba17bc1152e',
    collectorPath: '../../../conformance/recipes/issue1072-collector.mjs', createCollector: issue1072Collector,
    collectorDependencies: Object.freeze([Object.freeze({
      path: '../../../conformance/recipes/passive-query-context.mjs',
      sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f',
    })]),
    async replay({ program, check, assertion, poll }) {
      for (const [index, route] of ['pages/home/index', 'pages/external/index', 'pages/dynamic/index'].entries()) {
        const page = await program.reLaunch('/' + route)
        await poll(async () => (await page.$('#increment'))?.text(), '0')
        await (await page.$('#increment')).tap()
        await check(`package-${index}`, page, [{ selector: '#increment', text: '1' }])
      }
      assertion('issue #1072: JSON context page runtime navigates to metadata-configured pages with working reactive events')
    },
  },
  'ide-github-issues-runtime-issue1012': {
    sourceSha256: 'c91ec602d9bc78f722f5a3d4e4930e840f4227f8d567c0ee1c88063579bb67ff',
    collectorSha256: '9c22af295f85b8099cf78a6816f07ad7431548ba51e55a3059691562f018dfe5',
    collectorPath: '../../../conformance/recipes/issue1012-collector.mjs', createCollector: issue1012Collector,
    collectorDependencies: Object.freeze([Object.freeze({
      path: '../../../conformance/recipes/issue1012-descriptor.mjs',
      sha256: 'f2d42a299ace11e3f6c208cbd32a3b3c6386bc2495cd1b61b63acfa280c9ba4e',
    }), Object.freeze({
      path: '../../../conformance/recipes/passive-collector-core.mjs',
      sha256: 'd4c7f7067347f99d873e51e6aff0d8339893626fa875938f6158f6e505b85041',
    }), Object.freeze({
      path: '../../../conformance/recipes/passive-query-context.mjs',
      sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f',
    })]),
    async replay({ program, check, assertion }) {
      const page = await program.reLaunch('/pages/issue-1012/index')
      await check('initial', page, [
        { selector: '#issue1012-map-result', text: 'pending' },
        { selector: '#issue1012-results', text: 'pending' },
      ])
      const button = await page.$('#issue1012-run')
      require(button, 'Actual issue-1012 run button is absent')
      await button.tap()
      await check('executed', page, [
        { selector: '#issue1012-map-result', text: '[7]' },
        { selector: '#issue1012-results', text: '[8,9,10,11,12,13,99,99,99,99]' },
      ])
      assertion('e2e app: github-issues / issue #1012 keeps JavaScript this ownership across compiled template expressions')
    },
  },
  'ide-issue-1034-auto-routes-runtime': {
    sourceSha256: '7af17235a588c76b5cf8cf5f8659b35a7b806ba421ba67e59e5146b2b41f1a4c',
    collectorSha256: '002af68126d3f3cc6c93de7c0a6378dc58933f57dc961d32536072608cacb3b8',
    collectorPath: '../../../conformance/recipes/issue1034-collector.mjs', createCollector: issue1034Collector,
    collectorDependencies: Object.freeze([Object.freeze({
      path: '../../../conformance/recipes/issue1034-descriptor.mjs',
      sha256: 'b9db94ac2ea365255c343251480d57ff5b3ab4144ba36132f968157db2e0121e',
    })]),
    async replay({ program, check, assertion, poll }) {
      for (const [index, route] of ['pages/home/index', 'subpackages/account/pages/detail/index', 'subpackages/isolated/pages/detail/index'].entries()) {
        const page = await program.reLaunch('/' + route)
        await poll(async () => (await page.$('#source'))?.text(), `vue-business-${index}`)
        const button = await page.$('#increment')
        require(button, 'Actual issue-1034 increment button is absent')
        await button.tap()
        await check(`package-${index}`, page, [
          { selector: '#source', text: `vue-business-${index}` },
          { selector: '#increment', text: '1' },
        ])
      }
      assertion('issue #1034: selected sources across package boundaries navigates to each selected Vue page with its explicit sibling import and working events')
    },
  },
  'ide-github-issues-runtime-issue1014': {
    sourceSha256: '332a6673e36403659dc83eb634177e239400e748e2d346b50c7569f17e552bc8',
    collectorSha256: '96d2b1edd8f5100d391ac01b29e5311fc78dda9d39b455cd0d54b4241e49ecba',
    collectorPath: '../../../conformance/recipes/issue1014-collector.mjs', createCollector: issue1014Collector,
    collectorDependencies: Object.freeze([Object.freeze({
      path: '../../../conformance/recipes/issue1014-descriptor.mjs',
      sha256: '839d9688a3a5140bd80f36c54c36bcc9b0f52c3b20e827f574cfc576fa1c567a',
    }), Object.freeze({
      path: '../../../conformance/recipes/passive-collector-core.mjs',
      sha256: 'd4c7f7067347f99d873e51e6aff0d8339893626fa875938f6158f6e505b85041',
    }), Object.freeze({
      path: '../../../conformance/recipes/passive-query-context.mjs',
      sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f',
    })]),
    async replay({ program, check, assertion }) {
      const page = await program.reLaunch('/pages/issue-1014/index')
      await check('explicit-control-initial', page, [
        { selector: '#issue1014-title', text: 'issue 1014 object directives' },
        { selector: '#issue1014-explicit-control', attributes: { 'data-title': 'unsupported-object-title' } },
        { selector: '#issue1014-explicit-count', text: '0' },
      ])
      await (await page.$('#issue1014-explicit-control')).tap()
      await check('explicit-control-tapped', page, [{ selector: '#issue1014-explicit-count', text: '1' }])
      assertion('e2e app: github-issues / issue #1014 reports unsupported object directives while explicit attributes and events keep working')
    },
  },
}
cases['ide-wxml-transform-runtime'] = {
  sourceSha256: '697e7f72f545f1c8df358930c5ecca297d8888bb16f0cf01a4bc88084392d4a2',
  collectorSha256: '0372f59e2a46d222d38639401573ff7cf85fb0743a74272fe5283eae94345970',
  collectorPath: '../../../conformance/recipes/wxml-transform-collector.mjs', createCollector: wxmlCollector,
  collectorDependencies: Object.freeze([Object.freeze({
    path: '../../../conformance/recipes/wxml-transform-descriptor.mjs',
    sha256: '732033f1a7066266343f14e6ddff8af62b087ce57b8c1e654f99f1cd37c327aa',
  })]),
  requiresOracleTrace: true, oracleInputs: 'wxml', replayObserved: replayWxml,
}
cases['ide-github-issues-runtime-subpackage-item'] = {
  sourceSha256: '2fad80fcbe8cb7d00cc87091ae7fce34a954650e8446ccbf374dcb164c129e13',
  collectorSha256: 'd1dcd0b950a252efa9ae12fdc60200761256c512d0128467641b1a19f473674d', collectorPath: '../../../conformance/recipes/subpackage-item-collector.mjs', createCollector: itemCollector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/subpackage-item-descriptor.mjs', sha256: '9e98b2f417cf151d1535a082afd69d0cb80eadce5a9861132f00ee5b3cef3515' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-plans-collector-core.mjs', sha256: '0b1fd8e737ef1bddbbb5139a3519250da2c121189d43f03bac4545a8b8022b71' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-dom-projection.mjs', sha256: 'a8b1a7c07884b5cdd8eda5470563d98bbd42ce2b8234eeb030991053c03ee401' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'subpackage', replayObserved: replaySubpackage,
}
cases['ide-github-issues-runtime-subpackage-user'] = {
  sourceSha256: 'b5504ae1432588556f30993d93ae2dccfbd0f27876457106afb0a91914cf48de',
  collectorSha256: '47ecb4d67ef0c9ac75a9c326811eef0b4e586cb3f027ea069e801ef41e45449d', collectorPath: '../../../conformance/recipes/subpackage-user-collector.mjs', createCollector: userCollector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/subpackage-user-descriptor.mjs', sha256: 'c0d3f38c20efdc98350563aab3d3825c0500d14c3322863e4a317b72e57aabb4' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-plans-collector-core.mjs', sha256: '0b1fd8e737ef1bddbbb5139a3519250da2c121189d43f03bac4545a8b8022b71' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-dom-projection.mjs', sha256: 'a8b1a7c07884b5cdd8eda5470563d98bbd42ce2b8234eeb030991053c03ee401' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'subpackage', replayObserved: replaySubpackage,
}
cases['ide-github-issues-runtime-web-runtime'] = {
  sourceSha256: '2cf0345a293123b3be37f091663b77ee2aab1dd7c6d062512a5e6b45242cfb36',
  collectorSha256: '470458ba31c9302fe723a40b9521bf33f447023e12328c6a50739098e62d845d', collectorPath: '../../../conformance/recipes/web-runtime-collector.mjs', createCollector: webRuntimeCollector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/web-runtime-descriptor.mjs', sha256: '16c5fe4528a8e5bf2f96ebe01b5ea0c7348fbee1c450456acb327a791a491867' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-plans-collector-core.mjs', sha256: '0b1fd8e737ef1bddbbb5139a3519250da2c121189d43f03bac4545a8b8022b71' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-dom-projection.mjs', sha256: 'a8b1a7c07884b5cdd8eda5470563d98bbd42ce2b8234eeb030991053c03ee401' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'webRuntime', replayObserved: replayWebRuntime,
}
cases['ide-github-issues-runtime-issue547'] = {
  sourceSha256: '46bd53dda261261a5a9cd5e1e3fc89e07a8fd7660e0fcbbe3e8bdd73499f3f11',
  collectorSha256: 'ce6494dd44d8a12c0e5afdaf9d7ea457ce7d92f2705779ba0462f91ff016515f', collectorPath: '../../../conformance/recipes/issue547-collector.mjs', createCollector: issue547Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue547-descriptor.mjs', sha256: 'e6aadead9e1191b33566e6e1dcd71768dfff87b2ac13e739bc41237d8f181f24' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'issue547', replayObserved: replayComponentScopeFamily,
}
cases['ide-github-issues-runtime-issue289'] = {
  sourceSha256: 'eebdc8af20fa9f95c145520fd26914788bebfc46208adb2362797ac711c34c53',
  collectorSha256: 'ef0b38f6071f8381796e5d2731bf72653a2d3477047e0efe72d697055d0c228d', collectorPath: '../../../conformance/recipes/issue289-collector.mjs', createCollector: issue289Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue289-descriptor.mjs', sha256: '4071fe199c5d0564eaa83c93669f57d67ea942ceb5d4758b0fa42416ded821fc' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'issue289', replayObserved: replayComponentScopeFamily,
}
cases['ide-github-issues-runtime-issue1013'] = {
  sourceSha256: 'dd214fe8af937331788f4b491b51c9fd0816fe45614c28e3f9a192c29781cb35',
  collectorSha256: 'af05ea061c749307bf1f6e6fefcfa50d0e84a20b8bb1fcf36ee9b7d36513566e', collectorPath: '../../../conformance/recipes/issue1013-collector.mjs', createCollector: issue1013Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue1013-descriptor.mjs', sha256: 'ee9cfaeaef3466ff12b20c96d1866366adc82fb640c687017de6310ee132b3ee' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'sourcePlan1013', replayObserved: replayIssue1013,
}
cases['ide-template-weapp-vite-multi-platform-template'] = {
  sourceSha256: '5968eea1626e824c54b73555a0d655059e20e2fe87e3fff0908ca9e119da32e7',
  collectorSha256: '3eddd8b66971808b81f388d81578a8d6d4ab403f642ab08c94e91b7d1e1c6568', collectorPath: '../../../conformance/recipes/template-multi-platform-collector.mjs', createCollector: templateCollector,
  collectorDependencies: templateCollectorDependencies,
  requiresOracleTrace: true, oracleInputs: 'template', replayObserved: replayTemplate,
}
cases['ide-template-weapp-vite-multi-platform-sfc-template'] = {
  sourceSha256: '41dbc3838ad1a3b7ab6d6d7cd03df7690586d2d0623ca84214cbac2fcec51a8b',
  collectorSha256: 'e6fc2652adc1f03965bdb69650e3c4f94c0292764af55538b5f733ac018ec951', collectorPath: '../../../conformance/recipes/template-multi-platform-sfc-collector.mjs', createCollector: templateSfcCollector,
  collectorDependencies: templateSfcCollectorDependencies,
  requiresOracleTrace: true, oracleInputs: 'templateSfc', replayObserved: replayTemplateSfc,
}
cases['ide-github-issues-runtime-issue297-302'] = {
  sourceSha256: 'aee42467cd56a31d550bc4e345c6691b3651d47b12efcdf860945854227fc2a6', collectorSha256: 'aab73c28fdb4570f843a618b3103bd04f2bd5dd4b7588994484f48a6c42d4102',
  collectorPath: '../../../conformance/recipes/issue297-302-collector.mjs', createCollector: issue297302Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue297-302-descriptor.mjs', sha256: '426d415d26832b769b0509ec3643df407d4e9300b781339a9246383bbe834f0b' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'sourcePlan297302', replayObserved: replayIssue297302,
  requiredNativeFeatures: Object.freeze(['conformance-observation']),
}
cases['ide-github-issues-runtime-import-meta'] = {
  sourceSha256: '87bf4d6ff17686b0b10dcdfd19d21292aa2a5de1f049ad209cbfee98c0cb2c09',
  collectorPath: '../../../conformance/recipes/import-meta-collector.mjs', collectorSha256: '3b26958f413d7f1aaa2907de6cc673e56c746b9f44b9c3dc1ebfee78640fa56a', createCollector: importMetaCollector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/import-meta-descriptor.mjs', sha256: '6416f5aac164ef7b597b5623f1fa52a840becd8a76fd90ebf07003a3c8c65881' }),
    Object.freeze({ path: '../../../conformance/recipes/import-meta-source-policy.mjs', sha256: 'a8ccb52fb0cf38ffb994e5508ef4716f4c5b09e4929eb0eca45d60a37f1014bc' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'sourcePlanImportMeta', replayObserved: replayImportMeta,
  requiredNativeFeatures: Object.freeze(['conformance-observation']),
}
cases['ide-issue-1182-production-mount-runtime'] = {
  sourceSha256: '618a54f29892015fa49dd32b960179d90ee19c02a452883b4ca6f892e58e65d7', collectorSha256: '59b2f2714cd670448d72d6d0405ccb9dc285dcc1db85b3727cb5b71305091aaf',
  collectorPath: '../../../conformance/recipes/issue1182-collector.mjs', createCollector: issue1182Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue1182-descriptor.mjs', sha256: 'e140e1325be509ac4d5365772ffeade2a47757385c9e2ec25f035147dd4e08c4' }),
    Object.freeze({ path: '../../../conformance/recipes/source-exception-capture.mjs', sha256: '98e2647dad8c608a55d9c5ceb9c36bbab9f44b0b9a633286314fc648a11adb87' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'sourcePlan1182', replayObserved: replayIssue1182,
  requiredNativeFeatures: Object.freeze(['conformance-exception-channel']),
}
cases['ide-github-issues-runtime-issue1008'] = {
  sourceSha256: '28b80e5be581f5b825ef1be7c998b1db14a8566581d8528d11697cf03a786e47', collectorPath: '../../../conformance/recipes/issue1008-collector.mjs',
  collectorSha256: '76413c25eae90b82c1f244770f1db1dd725b545b40c59544ef370490a58318c1', createCollector: issue1008Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue1008-descriptor.mjs', sha256: '364bab2441277b0b5cdb32f46bed99679fd8630e2a24c0c8b5f57bcef906dcfc' }),
    Object.freeze({ path: '../../../conformance/recipes/issue1008-source-policy.mjs', sha256: '0123e1653df0b088c0df8dfe8a3c8a1fd7a7a1f07aa9804ac441cf86f61ff611' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'sourcePlan1008', replayObserved: replayIssue1008,
  requiredNativeFeatures: Object.freeze(['conformance-observation']),
}
cases['ide-github-issues-runtime-issue1009'] = {
  sourceSha256: '7aab6c9ec6c09f610bd8c13ae834dd63d96f906d40b2a5f86448a1f114bf56e9', collectorPath: '../../../conformance/recipes/issue1009-collector.mjs',
  collectorSha256: 'bc7d89a1937437afe13a6ab1921ac1e073ded39c89e85d85ad30b5e38e3b09bf', createCollector: issue1009Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue1009-descriptor.mjs', sha256: '2e8fc8114e8844fb5cd744139a97fad58abad4c8f85e4bb51761bfc0fffd52c3' }),
    Object.freeze({ path: '../../../conformance/recipes/issue1009-source-policy.mjs', sha256: '512383399830d6589e7cf957ca1ac88f100feb52e7f9fad6dc9e5a540fb465e8' }),
    Object.freeze({ path: '../../../conformance/recipes/issue1009-source-assertions.mjs', sha256: '8a861192b505bf5c200154b6b08260683b6560d5bdea868faf50a39de2985d7e' }),
    Object.freeze({ path: '../../../conformance/recipes/source-poll-observer.mjs', sha256: 'ee5e20679f26081d2bca44f84cf17ab4f4d4af0cda26f556c2ca900d6847fc48' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'sourcePlan1009', replayObserved: replayIssue1009,
  requiredNativeFeatures: Object.freeze(['conformance-observation']),
}
cases['ide-github-issues-runtime-issue941'] = {
  sourceSha256: '8789b12749c7c6e96a6a8e96bb70b058dddeffca771c83b1952eb2159ffb3405', collectorPath: '../../../conformance/recipes/issue941-collector.mjs',
  collectorSha256: 'ed618dced1b68f07237f5bc6563f0f65b6bd319b21a5ee6bfdd919e14bf05263', createCollector: issue941Collector,
  collectorDependencies: Object.freeze([
    Object.freeze({ path: '../../../conformance/recipes/issue941-descriptor.mjs', sha256: '0f9b6b42b2ed0d82405f4b935430b58fba4cffbb676d1001b87e75314d1c07b0' }),
    Object.freeze({ path: '../../../conformance/recipes/issue941-source-assertions.mjs', sha256: '2235e10c837a0431bc3659d9533052fb1aaf404ed6604cecb8ffc7ac68ccebed' }),
    Object.freeze({ path: '../../../conformance/recipes/ordered-steps-collector-core.mjs', sha256: 'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67' }),
    Object.freeze({ path: '../../../conformance/recipes/passive-query-context.mjs', sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f' }),
    Object.freeze({ path: '../../../conformance/recipes/source-method-values.mjs', sha256: 'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3' }),
  ]),
  requiresOracleTrace: true, oracleInputs: 'sourcePlan941', replayObserved: replayIssue941,
  requiredNativeFeatures: Object.freeze(['conformance-observation']),
}
cases['ide-github-issues-runtime-issue826']={
 sourceSha256:'060480ba6f466ae292552a78de6dc45c15e3699aa881356659f1fe3bbe88d099',collectorPath:'../../../conformance/recipes/issue826-collector.mjs',
 collectorSha256:'9c0802db1adcd84514fc2bab8946524d4d98f807c034985b32b7c4817a80c0d8',createCollector:issue826Collector,collectorDependencies:Object.freeze([
 Object.freeze({path:'../../../conformance/recipes/issue826-descriptor.mjs',sha256:'8fba15087dba90e302c351210792260ae0170591dbb3717ce2794a56217c213c'}),
 Object.freeze({path:'../../../conformance/recipes/source-runtime-log-capture.mjs',sha256:'9b3de6b13054b44edd93c2224ce390fc2b04c19ceb20f33152f890e51b0662e1'}),
 Object.freeze({path:'../../../conformance/recipes/ordered-steps-collector-core.mjs',sha256:'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67'}),
 Object.freeze({path:'../../../conformance/recipes/passive-query-context.mjs',sha256:'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f'}),
 Object.freeze({path:'../../../conformance/recipes/source-method-values.mjs',sha256:'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3'}),
]),requiresOracleTrace:true,oracleInputs:'sourcePlan826',replayObserved:replayIssue826,requiredNativeFeatures:Object.freeze(['conformance-observation']),
}
cases['ide-github-issues-runtime-issue1011'] = {
 sourceSha256:'d7dacedd9dc11c244ec49ef22491829d1b316d2f1ad8b72f574be6408c55fdfa',collectorPath:'../../../conformance/recipes/issue1011-collector.mjs',
 collectorSha256:'a4c1bdd45b34dee4a50c6e846ff15c736522359487707b1fcc972df975dfc2aa',createCollector:issue1011Collector,collectorDependencies:Object.freeze([
  Object.freeze({path:'../../../conformance/recipes/issue1011-descriptor.mjs',sha256:'f257fbf794accff8c3917466a7e87a051f79f7986c5451a990ca6ebf5753e891'}),
  Object.freeze({path:'../../../conformance/recipes/issue1011-source-policy.mjs',sha256:'55cd99a33d505b1d0c7be29f45f1344d47cb6667c904e0f0bc059665750085d9'}),
  Object.freeze({path:'../../../conformance/recipes/issue1011-source-assertions.mjs',sha256:'0e7e3d795529b34134638ab52523f7d373ccda13b86a466f875cc75966fe874e'}),
  Object.freeze({path:'../../../conformance/recipes/issue1011-original-values.mjs',sha256:'a24c3407858f8d8e413b129546529682f2835fedf7feaf879b45e086cbf6c63e'}),
  Object.freeze({path:'../../../conformance/recipes/issue1011-pure-read.mjs',sha256:'e98d291097fa3164b5bffc74a2a673bd9cfcd5c78f402ebd823205a6bf291be6'}),
  Object.freeze({path:'../../../conformance/recipes/source-poll-observer.mjs',sha256:'ee5e20679f26081d2bca44f84cf17ab4f4d4af0cda26f556c2ca900d6847fc48'}),
  Object.freeze({path:'../../../conformance/recipes/ordered-steps-collector-core.mjs',sha256:'cc84b287766d95a5776681a7e05cb01ea19d31ea2f8d32522e48da8cad505b67'}),
  Object.freeze({path:'../../../conformance/recipes/passive-query-context.mjs',sha256:'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f'}),
  Object.freeze({path:'../../../conformance/recipes/source-method-values.mjs',sha256:'c73d4757d9c444663bdbfd4b0989844cb4d7543f447e1e2614ef4763003cd9d3'}),
 ]),requiresOracleTrace:true,oracleInputs:'sourcePlan1011',replayObserved:replayIssue1011,
 requiredNativeFeatures:Object.freeze(['conformance-observation','accepted-frame-node-input']),
}
for (const definition of Object.values(cases)) Object.freeze(definition)

export { uniqueCollectorInputs } from './collector-inputs.mjs'

export function collectorInputs() {
  return uniqueCollectorInputs(Object.values(cases).flatMap(({ collectorPath, collectorSha256, collectorDependencies = [] }) => [
    { path: collectorPath, sha256: collectorSha256 },
    ...collectorDependencies,
  ]))
}

export function caseDefinition(caseId) {
  const definition = cases[caseId]
  require(definition, `Native replay has no reviewed pinned case: ${caseId}`)
  return definition
}

export async function replayCase({ caseId, request, signal, pollTimeoutMs = 15000, oracleTrace, staticInputs, startup }) {
  const definition = caseDefinition(caseId)
  if (definition.requiresOracleTrace) return definition.replayObserved({ caseId, request, signal, oracleTrace, staticInputs, startup })
  const events = [], assertions = []
  const collector = definition.createCollector({ emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  const program = createNativeProgram(request)
  collector.attach(program)
  const check = async (id, page, expected) => {
    const queries = expected.map(({ selector, scope, text, attributes }) => {
      const names = Object.keys(attributes ?? {})
      if (!names.length) return scope?.length ? { selector, scope: [...scope] } : selector
      // Field selection contains names/booleans only. Values stay in assertions.
      return { selector, ...(scope?.length ? { scope: [...scope] } : {}), fields: { text: text !== undefined, attributes: names } }
    })
    const evidence = await request('checkpoint', { route: page.path, checkpoint: id, selectors: queries })
    require(evidence?.id === id && evidence.route === page.path, 'Native checkpoint returned another actual route or checkpoint')
    assertCheckpoint(evidence, expected)
    collector.checkpoint({ evidence })
  }
  const poll = async (read, expected) => {
    const deadline = Date.now() + pollTimeoutMs
    let actual, failure
    do {
      if (signal?.aborted) throw signal.reason ?? new Error('Native replay aborted')
      try { actual = await read(); if (actual === expected) return; failure = undefined } catch (error) { failure = error }
      if (Date.now() >= deadline) break
      await delay(Math.min(20, deadline - Date.now()), undefined, { signal })
    } while (Date.now() <= deadline)
    throw failure ?? new Error(`Actual native polled text differs: ${JSON.stringify(actual)}`)
  }
  try {
    await definition.replay({ program, check, assertion: id => assertions.push({ id, passed: true }), poll })
    collector.flush()
    return { events, assertions }
  } catch (error) {
    try { collector.flush() } catch { /* Preserve the primary native operation/assertion failure. */ }
    throw error
  }
}
