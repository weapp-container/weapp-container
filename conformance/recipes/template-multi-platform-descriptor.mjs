/** Coverage only, derived from unchanged multiPlatformTemplateDom(false).
 * No expected rendered text, count, snapshot content or guest return value. */
const queries = Object.freeze([
  Object.freeze({ selector: '.page-heading__title' }),
  Object.freeze({ selector: '#platform-marker' }),
  Object.freeze({ selector: '#runtime-status' }),
  Object.freeze({ selector: '.platform-card__value', scope: Object.freeze(['#platform-card-host']) }),
  Object.freeze({ selector: '#counter-value' }),
])
export const descriptor = Object.freeze({
  caseId: 'ide-template-weapp-vite-multi-platform-template',
  sourceSha256: '5968eea1626e824c54b73555a0d655059e20e2fe87e3fff0908ca9e119da32e7',
  caseSourcePath: 'e2e/ide/template-weapp-vite-multi-platform-template.test.ts',
  templateRelativePath: 'templates/weapp-vite-multi-platform-template',
  compiledFiles: Object.freeze(['app.json', 'app.wxss', 'pages/index/index.wxml']),
  test: 'template e2e: weapp-vite-multi-platform-template renders and updates the WeChat target',
  route: 'pages/index/index',
  checkpoints: Object.freeze([
    Object.freeze({ id: '/pages/index/index:initial', queries, taps: 0 }),
    Object.freeze({ id: 'index:increment', queries, taps: 1 }),
  ]),
  action: Object.freeze({ afterCheckpoint: 1, selector: '#increment-button' }),
})
