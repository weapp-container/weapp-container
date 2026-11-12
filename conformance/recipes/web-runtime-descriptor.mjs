/** Source addresses, fields and order only. Expected values remain in the
 * unchanged source/original trace; test titles are provenance, not task IDs. */
const text = selector => Object.freeze({ selector, text: true })
const query = value => Object.freeze({ ...value, ...(value.scope ? { scope: Object.freeze(value.scope) } : {}) })
const plan = (ordinal, issue, test, queries) => Object.freeze({ ordinal, test,
  route: `pages/issue-${issue}/index`, actions: Object.freeze([]),
  renderedRoots: Object.freeze([`#issue${issue}-page`, `#issue-${issue}-page`, `.issue${issue}-page`, `.issue-${issue}-page`]),
  checkpoints: Object.freeze([Object.freeze({ id: 'initial', queries: Object.freeze(queries) })]) })
export const descriptor = Object.freeze({
  caseId: 'ide-github-issues-runtime-web-runtime',
  caseSourcePath: 'e2e/ide/github-issues.runtime.web-runtime.test.ts',
  sourceSha256: '2cf0345a293123b3be37f091663b77ee2aab1dd7c6d062512a5e6b45242cfb36',
  plans: Object.freeze([
    plan(0, 1186, 'issue #1186: decodes malformed URL queries without losing live search params',
      ['title', 'decoded', 'replacement', 'live', 'serialized'].map(key => text(`#issue1186-${key}`))),
    plan(1, 448, 'issue #448: compiles the next batch of web runtime globals for DevTools', [
      text('.issue448-title'),
      ...['encoded', 'decoded', 'event', 'custom', 'url', 'canParse', 'params', 'cookies', 'json', 'error', 'microtask'].map(key => text(`#issue448-${key}`)),
      query({ selector: '.issue448-line' }),
    ]),
    plan(2, 459, 'issue #459: compiles directly imported web-apis polyfills for DevTools', [
      text('.issue459-title'),
      ...['requestUrl', 'requestOwnBody', 'responseOwnBody', 'responseOwnBodyValue', 'responseKeys', 'textCodec'].map(key => text(`#issue459-${key}`)),
      query({ selector: '.issue459-line' }),
    ]),
    plan(3, 804, 'issue #804: keeps web runtime platform exports available to custom components', [
      text('#issue804-title'), text('#issue804-ready'), query({ selector: '.issue804-pressable', scope: ['#issue804-pressable'] }),
    ]),
  ]),
  compiledFiles: Object.freeze(['pages/issue-1186/index.wxml', 'pages/issue-1186/index.json', 'pages/issue-1186/index.js',
    'pages/issue-448/index.wxml', 'pages/issue-448/index.js', 'pages/issue-459/index.wxml', 'pages/issue-459/index.js', 'pages/issue-804/index.wxml']),
  compiledDirectories: Object.freeze([Object.freeze({ path: 'weapp-vendors', extension: '.js' })]),
})
