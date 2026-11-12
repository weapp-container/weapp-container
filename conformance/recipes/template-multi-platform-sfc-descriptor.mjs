/** Coverage only, derived from unchanged multiPlatformTemplateDom(true).
 * No expected rendered text, count, snapshot content or guest return value. */
const queries = Object.freeze([
  Object.freeze({ selector: '.page-heading__title' }),
  Object.freeze({ selector: '#platform-marker' }),
  Object.freeze({ selector: '#runtime-status' }),
  Object.freeze({ selector: '#component-platform', scope: Object.freeze(['#platform-card-host']) }),
  Object.freeze({ selector: '#counter-value' }),
  Object.freeze({ selector: '#counter-doubled' }),
])
export const descriptor = Object.freeze({
  caseId: 'ide-template-weapp-vite-multi-platform-sfc-template',
  sourceSha256: '41dbc3838ad1a3b7ab6d6d7cd03df7690586d2d0623ca84214cbac2fcec51a8b',
  caseSourcePath: 'e2e/ide/template-weapp-vite-multi-platform-sfc-template.test.ts',
  templateRelativePath: 'templates/weapp-vite-multi-platform-sfc-template',
  compiledFiles: Object.freeze(['app.json', 'app.wxss', 'pages/index/index.wxml']),
  test: 'template e2e: weapp-vite-multi-platform-sfc-template renders and updates the WeChat SFC target',
  route: 'pages/index/index',
  checkpoints: Object.freeze([
    Object.freeze({ id: '/pages/index/index:initial', queries, taps: 0 }),
    Object.freeze({ id: 'index:increment', queries, taps: 1 }),
  ]),
  action: Object.freeze({ afterCheckpoint: 1, selector: '#increment-button' }),
})
