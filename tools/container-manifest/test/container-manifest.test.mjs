import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildManifest,
  canonicalize,
  capabilityMatrix,
  parseWxml,
  parseWxss,
  packContainer,
  sha256,
  extractStaticModuleSpecifiers,
} from '../src/index.ts';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-container-'));
  await mkdir(path.join(root, 'pages', 'home'), { recursive: true });
  await mkdir(path.join(root, 'components', 'hello'), { recursive: true });
  await mkdir(path.join(root, 'pkg', 'pages', 'settings'), { recursive: true });
  await mkdir(path.join(root, 'utils'), { recursive: true });
  await writeFile(path.join(root, 'app.json'), JSON.stringify({
    pages: ['pages/home/index'],
    subpackages: [{ root: 'pkg', pages: ['pages/settings/index'] }],
    tabBar: { list: [{ pagePath: 'pages/home/index' }] },
  }));
  await writeFile(path.join(root, 'app.js'), 'App({ globalData: { ready: true } });\n');
  await writeFile(path.join(root, 'app.wxss'), 'page { color: #123456; }\n');
  await writeFile(path.join(root, 'pages/home/index.js'), 'const shared = require("../../utils/shared");\nPage({ data: { title: shared.title } });\n');
  await writeFile(path.join(root, 'utils/shared.js'), 'export const title = "home";\n');
  await writeFile(path.join(root, 'pages/home/index.json'), '{"usingComponents":{"hello":"../../components/hello/index"}}\n');
  await writeFile(path.join(root, 'pages/home/index.wxml'), '<view>{{ title }} {{user.name}}</view>\n');
  await writeFile(path.join(root, 'pages/home/index.wxss'), '.title { color: red; }\n');
  await writeFile(path.join(root, 'components/hello/index.js'), 'Component({});\n');
  await writeFile(path.join(root, 'components/hello/index.wxml'), '<text>Hello</text>\n');
  await writeFile(path.join(root, 'pkg/pages/settings/index.js'), 'Page({});\n');
  await writeFile(path.join(root, 'pkg/pages/settings/index.wxml'), '<view>Settings</view>\n');
  await writeFile(path.join(root, 'assets.bin'), Buffer.from([0, 1, 2, 3]));
  return root;
}

test('canonicalize is stable and sha256 hashes UTF-8 bytes', () => {
  assert.equal(canonicalize({ z: 1, a: ['中', true] }), '{"a":["中",true],"z":1}');
  assert.equal(sha256(Buffer.from('hello')), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('wx:key bare property names remain literal metadata instead of executable expressions', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const propertyNames = ['id', 'class', 'with', 'first-name', 'constructor', '*this'];
  const source = propertyNames.map(key => `<view wx:for="{{rows}}" wx:key="${key}"/>`).join('');
  await writeFile(path.join(root, 'pages/home/index.wxml'), source);
  const result = await buildManifest(root, { compilerCommit: 'literal-for-key' });
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  const document = result.manifest.viewCompilation.documents.find(item => item.documentId === 'pages/home/index.wxml');
  assert.deepEqual(document.expressions.map(item => [item.source, item.shorthand]), [['rows', false]],
    'only wx:for evaluates code; bare key property names have no execution record');
  const template = result.manifest.templates.find(item => item.id === 'template:pages/home/index.wxml');
  const ast = JSON.parse(result.blobs.get(template.wxmlAst.slice('sha256:'.length)));
  assert.deepEqual(ast.nodes.map(node => node.directives.forKey), propertyNames);
  assert.deepEqual(ast.nodes.map(node => node.attrs['wx:key']), propertyNames, 'source attributes remain lossless');
});

test('wx:key retains the existing dotted loop-scope extension and compiles its property reads', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'pages/home/index.wxml'),
    '<view wx:for="{{rows}}" wx:for-item="row" wx:key="row.constructor"/>');
  const result = await buildManifest(root, { compilerCommit: 'dotted-for-key' });
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  const document = result.manifest.viewCompilation.documents.find(item => item.documentId === 'pages/home/index.wxml');
  assert.deepEqual(document.expressions.map(item => item.source), ['row.constructor', 'rows']);
  const key = document.expressions.find(item => item.source === 'row.constructor');
  assert.match(result.blobs.get(key.executableSha256).toString('utf8'), /\.read\(\(row\),"constructor"\)/,
    'dotted extension uses the same WXS dialect property ABI');
});

test('malformed dotted wx:key extension is still an explicit syntax error', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'pages/home/index.wxml'), '<view wx:for="{{rows}}" wx:key="row."/>');
  const result = await buildManifest(root, { compilerCommit: 'invalid-dotted-for-key' });
  assert.ok(result.diagnostics.some(item => item.severity === 'error' && item.code === 'ERR_UNSUPPORTED_WXS_SYNTAX'));
  await assert.rejects(packContainer(root, path.join(root, 'invalid-pack'), { compilerCommit: 'invalid-dotted-for-key' }),
    { code: 'ERR_INVALID_MANIFEST' }, 'diagnostics prevent publication of an invalid executable document');
});

test('WXS packs use a separate complete graph with lexical external and inline bindings', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const sources = new Map([
    ['utils/dep.wxs', 'exports.label = function(value) { return value; };'],
    ['utils/helper.wxs', String.raw`var dep = require('./\u0064ep.wxs'); module.exports = dep;`],
    ['utils/unused.wxs', 'module.exports = {};'],
  ]);
  for (const [file, source] of sources) await writeFile(path.join(root, file), source);
  const inline = 'var dep = require("../../utils/dep.wxs"); module.exports = { label: dep.label, literal: "{{notABinding}}" };';
  await writeFile(path.join(root, 'pages/home/index.wxml'), `<wxs module="tools" src="../../utils/helper.wxs"/><wxs module="inlineTools">${inline}</wxs><text>{{tools.label(title)}}</text>`);
  await writeFile(path.join(root, 'components/hello/index.wxml'), '<wxs module="tools">module.exports = {};</wxs><text>Hello</text>');
  const result = await buildManifest(root, { compilerCommit: 'wxs-graph' });
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  assert.deepEqual(result.manifest.viewScripts.map(module => module.id), [
    'wxs:components/hello/index.wxml#tools', 'wxs:pages/home/index.wxml#inlineTools',
    'wxs:utils/dep.wxs', 'wxs:utils/helper.wxs', 'wxs:utils/unused.wxs',
  ]);
  assert.equal(result.manifest.modules.some(module => module.id.endsWith('.wxs')), false);
  assert.equal(result.manifest.assets.some(asset => asset.path.endsWith('.wxs')), false);
  const page = result.manifest.templates.find(template => template.id === 'template:pages/home/index.wxml');
  assert.deepEqual(page.wxsModules, { inlineTools: 'wxs:pages/home/index.wxml#inlineTools', tools: 'wxs:utils/helper.wxs' });
  assert.deepEqual(page.bindings, ['tools.label(title)']);
  const component = result.manifest.templates.find(template => template.id === 'template:components/hello/index.wxml');
  assert.deepEqual(component.wxsModules, { tools: 'wxs:components/hello/index.wxml#tools' });
  assert.equal(result.manifest.templates.find(template => template.id === 'template:pkg/pages/settings/index.wxml').wxsModules, undefined);
  for (const module of result.manifest.viewScripts) {
    assert.ok(Array.isArray(module.dependencies), 'even empty WXS dependency graphs are explicit');
    assert.equal(sha256(result.blobs.get(module.sha256)), module.sha256);
  }
  assert.deepEqual(result.manifest.viewScripts.find(module => module.id === 'wxs:utils/helper.wxs').dependencies, ['wxs:utils/dep.wxs']);
  const inlineModule = result.manifest.viewScripts.find(module => module.id === 'wxs:pages/home/index.wxml#inlineTools');
  assert.deepEqual(inlineModule.dependencies, ['wxs:utils/dep.wxs']);
  assert.equal(result.blobs.get(inlineModule.sha256).toString('utf8'), inline);
  assert.equal(Object.keys(result.manifest.capabilities).some(name => /wxs/i.test(name)), false, 'packing does not advertise unimplemented execution');
  const unsigned = { ...result.manifest, integrity: { algorithm: 'sha256', root: '' } };
  assert.equal(result.manifest.integrity.root, sha256(Buffer.from(canonicalize(unsigned))));
  const output = path.join(root, 'portable-pack');
  await packContainer(root, output, { compilerCommit: 'wxs-graph' });
  assert.equal((await readFile(path.join(output, 'blobs/sha256', inlineModule.sha256))).toString('utf8'), inline);
});

test('WXS graph supports CommonJS cycles and ignores commented or quoted require text', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'utils/a.wxs'), 'var b = require("./b.wxs"); // require("./missing.wxs")\nmodule.exports = { b: b, text: "require(\\"./fake.wxs\\")" };');
  await writeFile(path.join(root, 'utils/b.wxs'), '/* require("missing") */ module.exports = require("./a.wxs");');
  const result = await buildManifest(root);
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  assert.deepEqual(result.manifest.viewScripts, [
    { id: 'wxs:utils/a.wxs', sha256: sha256(await readFile(path.join(root, 'utils/a.wxs'))), dependencies: ['wxs:utils/b.wxs'] },
    { id: 'wxs:utils/b.wxs', sha256: sha256(await readFile(path.join(root, 'utils/b.wxs'))), dependencies: ['wxs:utils/a.wxs'] },
  ]);
});

test('WXS dependencies reject dynamic, indirect, escaping, missing and non-WXS targets', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const source of [
    'require(name)', 'var load = require; load("./dep.wxs")', 'require("./dep")',
    'require("dep.wxs")', 'require("/utils/dep.wxs")', 'require("../../outside.wxs")',
    'require("./missing.wxs")', 'require("./shared.js")', 'require("./dep.wxs", 1)',
    'require(".//dep.wxs")', 'require("./dep.wxs?query")',
    'require("./dep.wxs#fragment")', String.raw`require('./de\\p.wxs')`,
    String.raw`require('./dep.wxs\u0000')`,
    String.raw`require('./\141.wxs')`,
  ]) {
    await writeFile(path.join(root, 'utils/dep.wxs'), 'module.exports = {};');
    await writeFile(path.join(root, 'utils/invalid.wxs'), source);
    const result = await buildManifest(root);
    assert.ok(result.diagnostics.some(item => item.code === 'ERR_INVALID_WXS_DEPENDENCY' && item.path === 'utils/invalid.wxs'), source);
    await assert.rejects(() => packContainer(root, path.join(root, 'out')), error => error.code === 'ERR_INVALID_MANIFEST');
  }
  await rm(path.join(root, 'utils/invalid.wxs'));
  await writeFile(path.join(root, 'app.js'), 'require("./utils/dep.wxs");');
  const appservice = await buildManifest(root);
  assert.ok(appservice.diagnostics.some(item => item.code === 'ERR_UNDECLARED_MODULE_DEPENDENCY' && item.path === 'app.js'));
});

test('WXS declaration validation rejects duplicate aliases and invalid source boundaries', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'utils/dep.wxs'), 'module.exports = {};');
  for (const source of [
    '<wxs module="tools"/><wxs module="tools"/>', '<wxs/>', '<wxs module="a.b"/>',
    '<wxs module="return"/>', '<wxs module="tools" src=""/>',
    '<wxs module="tools" src="../../utils/dep.wxs">module.exports = {};</wxs>',
    '<wxs module="tools" src="../../../outside.wxs"/>', '<wxs module="tools" src="../../utils/shared.js"/>',
  ]) {
    await writeFile(path.join(root, 'pages/home/index.wxml'), source);
    const result = await buildManifest(root);
    assert.ok(result.diagnostics.some(item => item.code === 'ERR_INVALID_MANIFEST' && item.path === 'pages/home/index.wxml'), source);
  }
  await writeFile(path.join(root, 'pages/home/index.wxml'), '<wxs module="__proto__" src="../../utils/dep.wxs"/><wxs module="constructor"/>');
  const result = await buildManifest(root);
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  const template = result.manifest.templates.find(item => item.id === 'template:pages/home/index.wxml');
  assert.equal(Object.hasOwn(template.wxsModules, '__proto__'), true);
  assert.equal(template.wxsModules.__proto__, 'wxs:utils/dep.wxs');
  assert.equal(template.wxsModules.constructor, 'wxs:pages/home/index.wxml#constructor');
});

test('WXS raw inline bytes survive the actual pack and schema constraints cover view identities', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const contract = JSON.parse(await readFile(new URL('./fixtures/wxml-wxs-raw-v1.json', import.meta.url), 'utf8'));
  await writeFile(path.join(root, 'pages/home/index.wxml'), contract.source);
  const result = await buildManifest(root);
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  const inline = result.manifest.viewScripts.find(item => item.id.startsWith('wxs:pages/home/index.wxml#'));
  const declaration = parseWxml(contract.source).nodes[0].children.find(node => node.kind === 'element' && node.tag === 'wxs');
  assert.equal(result.blobs.get(inline.sha256).toString('utf8'), declaration.children.map(node => node.value).join(''));
  const schema = JSON.parse(await readFile(new URL('../../../schemas/container-manifest-v1.schema.json', import.meta.url), 'utf8'));
  const external = new RegExp(schema.$defs.externalWxsId.pattern);
  const identity = new RegExp(schema.$defs.viewScriptId.pattern);
  for (const id of ['wxs:a.wxs', 'wxs:utils/a.wxs', 'wxs:.wxs']) assert.equal(external.test(id), true, id);
  for (const id of ['wxs:../a.wxs', 'wxs:utils/../a.wxs', 'wxs:utils/./a.wxs', 'wxs:/a.wxs', 'wxs:a\\b.wxs', 'wxs:a.wxs?query', 'wxs:a.wxml#tools']) assert.equal(external.test(id), false, id);
  for (const id of ['wxs:a.wxs', 'wxs:pages/a.wxml#tools']) assert.equal(identity.test(id), true, id);
  for (const id of ['wxs:../a.wxs', 'wxs:a.wxml#bad.name', 'module:a.wxs']) assert.equal(identity.test(id), false, id);
  assert.deepEqual(schema.$defs.viewScript.required, ['id', 'sha256', 'dependencies']);
});

test('WXS graph grammar packs division, regex, Unicode and nested dependencies without changing raw source', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'utils/dep.wxs'), 'module.exports = { n: 2 };');
  const sources = [
    ['module.exports = 10 / 2;', []],
    [String.raw`module.exports = /require\("\.\/ghost.wxs"\)/;`, []],
    ['do /[/*]/.test("x"); while (require("./dep.wxs"));', ['wxs:utils/dep.wxs']],
    ['if(false) {} else /[/*]/.test(require("./dep.wxs"));', ['wxs:utils/dep.wxs']],
    ['module.exports = `prefix-${require("./dep.wxs").n}`;', ['wxs:utils/dep.wxs']],
    [String.raw`module.exports = requ\u0069re('./\u0064ep.wxs');`, ['wxs:utils/dep.wxs']],
    ['function nested() { for (var i = 0; i < 1; i++) { /[/*]/.test(require("./dep.wxs")); } }', ['wxs:utils/dep.wxs']],
    ['var object = { require: 1 }; object.require; module.exports = { [require("./dep.wxs").n]: true };', ['wxs:utils/dep.wxs']],
  ];
  for (const [source, dependencies] of sources) {
    const raw = Buffer.from(source + '\r\n// preserved bytes 中\r\n');
    await writeFile(path.join(root, 'utils/grammar.wxs'), raw);
    const result = await buildManifest(root);
    assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), [], source);
    const script = result.manifest.viewScripts.find(item => item.id === 'wxs:utils/grammar.wxs');
    assert.deepEqual(script.dependencies, dependencies, source);
    assert.equal(script.sha256, sha256(raw));
    assert.deepEqual(result.blobs.get(script.sha256), raw);
  }
  const output = path.join(root, 'packed');
  const packed = await packContainer(root, output);
  const script = packed.manifest.viewScripts.find(item => item.id === 'wxs:utils/grammar.wxs');
  assert.deepEqual(await readFile(path.join(output, 'blobs/sha256', script.sha256)), await readFile(path.join(root, 'utils/grammar.wxs')));
});

test('WXS graph rejects malformed grammar and dynamic graph bypasses', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ['module.exports = /[/*]/; require(name);', 'ERR_INVALID_WXS_DEPENDENCY'],
    ['function load(require) { return require("./dep.wxs"); }', 'ERR_INVALID_WXS_DEPENDENCY'],
    ['var value = { require };', 'ERR_INVALID_WXS_DEPENDENCY'],
    ['typeof require;', 'ERR_INVALID_WXS_DEPENDENCY'],
    [String.raw`eval("require(\"./dep.wxs\")");`, 'ERR_UNSUPPORTED_WXS_SYNTAX'],
    ['Function("return 1");', 'ERR_UNSUPPORTED_WXS_SYNTAX'],
    ['with ({}) {}', 'ERR_UNSUPPORTED_WXS_SYNTAX'],
    ['import("./dep.wxs");', 'ERR_UNSUPPORTED_WXS_SYNTAX'],
    ['module.exports = /unterminated;', 'ERR_INVALID_WXS_SOURCE'],
    ['require("./dep.wxs"); function (', 'ERR_INVALID_WXS_SOURCE'],
  ];
  for (const [source, code] of cases) {
    await writeFile(path.join(root, 'utils/restricted.wxs'), source);
    const result = await buildManifest(root);
    assert.ok(result.diagnostics.some(item => item.code === code && item.path === 'utils/restricted.wxs'), source);
    await assert.rejects(() => packContainer(root, path.join(root, 'out')), error => error.code === 'ERR_INVALID_MANIFEST');
  }
});

test('WXS source validation rejects malformed UTF-8 in external and inline modules', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'utils/restricted.wxs'), Buffer.from([0x6d, 0x3d, 0xc3, 0x28]));
  const invalid = await buildManifest(root);
  assert.ok(invalid.diagnostics.some(item => item.code === 'ERR_INVALID_WXS_SOURCE' && item.path === 'utils/restricted.wxs'));
  await rm(path.join(root, 'utils/restricted.wxs'));
  await writeFile(path.join(root, 'pages/home/index.wxml'), Buffer.concat([
    Buffer.from('<wxs module="tools">module.exports.value = "'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('";</wxs>'),
  ]));
  const invalidInline = await buildManifest(root);
  assert.ok(invalidInline.diagnostics.some(item => item.code === 'ERR_INVALID_MANIFEST' && item.path === 'pages/home/index.wxml'));
  await assert.rejects(() => packContainer(root, path.join(root, 'invalid-inline-pack')), error => error.code === 'ERR_INVALID_MANIFEST');
  assert.equal(invalid.manifest.viewScripts, undefined, 'invalid UTF-8 never acquires a replacement-character graph');
  await assert.rejects(() => packContainer(root, path.join(root, 'out')), error => error.code === 'ERR_INVALID_MANIFEST');
});

test('WXML packer emits the shared Rust directive wire contract in actual blobs', async (context) => {
  const contract = JSON.parse(await readFile(new URL('./fixtures/wxml-directives-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseWxml(contract.source), contract.ast);
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'pages/home/index.wxml'), contract.source);
  const output = path.join(root, 'portable-pack');
  const result = await packContainer(root, output, { compilerCommit: 'directive-contract' });
  assert.equal(result.diagnostics.filter(item => item.severity === 'error').length, 0);
  const template = result.manifest.templates.find(item => item.id === 'template:pages/home/index.wxml');
  const bytes = await readFile(path.join(output, 'blobs', 'sha256', template.wxmlAst.slice('sha256:'.length)));
  assert.deepEqual(bytes, result.blobs.get(template.wxmlAst.slice('sha256:'.length)), 'published bytes match the validated in-memory blob');
  assert.equal(bytes.toString('utf8'), canonicalize(contract.ast));
  assert.equal(sha256(bytes), template.wxmlAst.slice('sha256:'.length));
  assert.equal(JSON.parse(bytes).nodes[0].children[0].attrs['wx:if'], '{{showChild}}', 'source attributes remain lossless');
  const buttons = JSON.parse(bytes).nodes.slice(1);
  assert.deepEqual(buttons.map(node => node.tag), ['button', 'button', 'button']);
  assert.equal(buttons[0].children[0].value, 'Increment', 'a direct button label survives packaging');
  assert.equal(buttons[0].directives.events.bindtap, 'increment');
  assert.equal(buttons[1].children[0].tag, 'text', 'nested button content survives packaging');
  assert.deepEqual(buttons[1].children[0].children[0].bindings, ['rows.length']);
  assert.equal(buttons[1].directives.events.bindtap, 'onTap');
  assert.deepEqual(buttons[2].children, [], 'an explicitly self-closing button remains empty');
  assert.ok(template.bindings.includes('rows.length'), 'nested button bindings remain in the executable document');
});

test('WXML button closing tags are required unless explicitly self-closing', () => {
  for (const source of ['<button>Increment', '<view><button>Increment</view>']) {
    assert.throws(() => parseWxml(source), /unexpected end of input|mismatched closing tag/, source);
  }
  const nodes = parseWxml('<view><button/><text>after</text></view>').nodes[0].children;
  assert.deepEqual(nodes.map(node => node.tag), ['button', 'text']);
  assert.deepEqual(nodes[0].children, []);
});

test('WXML button container fix preserves the existing implicit void-element contract', () => {
  for (const tag of ['input', 'image', 'icon', 'progress', 'checkbox', 'radio', 'switch', 'slider', 'camera', 'live-player', 'live-pusher']) {
    const nodes = parseWxml(`<view><${tag}><text>after</text></view>`).nodes[0].children;
    assert.deepEqual(nodes.map(node => node.tag), [tag, 'text'], tag);
    assert.deepEqual(nodes[0].children, [], tag);
  }
});

test('WXML directive normalization matches Rust trimming, key and event spellings', () => {
  const source = '<view wx:if="  {{ flag }}  " wx:for=" {{ values }} " wx:for-item=" row " wx:for-index=" pos " wx:key=" {{ *this }} " bind:tap="onTap" capture-catch:touchstart="stop" data-unknown="x"/>';
  const node = parseWxml(source).nodes[0];
  assert.deepEqual(node.directives, {
    ifExpr: 'flag', forExpr: 'values', forItem: 'row', forIndex: 'pos', forKey: '*this',
    events: { 'bind:tap': 'onTap', 'capture-catch:touchstart': 'stop' },
  });
  assert.equal(node.attrs['wx:key'], ' {{ *this }} ');
  assert.equal(Object.hasOwn(parseWxml('<view wx:if=" {{ }} " wx:for-item="  "/>').nodes[0], 'directives'), false);
  assert.equal(Object.hasOwn(parseWxml('<view constructor="x" toString="y" data-unknown="z"/>').nodes[0], 'directives'), false);
});

test('instance capability namespaces agree with the manifest schema and reject arbitrary namespace chains', async () => {
  const schema = JSON.parse(await readFile(new URL('../../../schemas/container-manifest-v1.schema.json', import.meta.url), 'utf8'));
  const pattern = new RegExp(schema.properties.capabilities.propertyNames.pattern);
  const names = ['Page.selectComponent', 'Page.selectAllComponents', 'Component.selectComponent', 'Component.selectAllComponents', 'Component.selectOwnerComponent', 'Component.triggerEvent', 'Component.relations', 'Component.getRelationNodes', 'Component.hasBehavior'];
  const matrix = capabilityMatrix(Object.fromEntries(names.map(name => [name, 'partial'])));
  for (const name of names) {
    assert.equal(matrix.capabilities[name].status, 'partial');
    assert.equal(pattern.test(name), true);
  }
  for (const name of ['Other.selectComponent', 'Page.', 'Component.selectComponent.deep', 'Page..selectComponent']) {
    assert.throws(() => capabilityMatrix({ [name]: 'partial' }), /Invalid capability name/);
    assert.equal(pattern.test(name), false);
  }
});

test('all locked host API catalog names survive capability packing and every schema', async () => {
  const catalog=JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json',import.meta.url),'utf8'));
  const names=catalog.apis.map(api=>api.name);
  const matrix=capabilityMatrix(Object.fromEntries(names.map(name=>[name,'partial'])));
  for(const schemaName of ['container-manifest-v1','container-manifest-v2','container-manifest-v3','capability-matrix-v1']) {
    const schema=JSON.parse(await readFile(new URL(`../../../schemas/${schemaName}.schema.json`,import.meta.url),'utf8'));
    const pattern=new RegExp(schema.properties.capabilities.propertyNames.pattern);
    for(const name of names) {assert.equal(pattern.test(name),true,`${schemaName}: ${name}`);assert.equal(matrix.capabilities[name].status,'partial');}
    for(const name of ['object:FileSystemManager','object:1Type.read','object:FileSystemManager.read.deep','component:button..getPhoneNumber','component:live--player','weappContainer.1identity.getState','weappContainer.identity..getState','untrusted:camera']) {
      assert.equal(pattern.test(name),false,`${schemaName}: ${name}`);
      assert.throws(()=>capabilityMatrix({[name]:'partial'}),/Invalid capability name/);
    }
  }
});

test('component relations capabilities stay partial and explicit lowering survives packing', async () => {
  const names = ['Component.relations', 'Component.getRelationNodes', 'Component.hasBehavior'];
  const fixtureRoot = fileURLToPath(new URL('../../../fixtures/reference-app', import.meta.url));
  const inventory = JSON.parse(await readFile(new URL('../../../docs/api-inventory-v1.json', import.meta.url), 'utf8'));
  const group = inventory.apis.find(api => api.id === 'component.relations');
  assert.deepEqual(group.names, names);
  assert.equal(group.support, 'partial');
  assert.deepEqual(group.conformance, ['component-relations-001', 'component-relations-002', 'component-relations-003']);
  for (const host of inventory.hosts) assert.equal(group.hostCoverage[host], 'partial');
  for (const engine of inventory.engines) assert.equal(group.engineCoverage[engine], 'partial');

  const defaults = await buildManifest(fixtureRoot);
  const lowered = await buildManifest(fixtureRoot, { capabilities: { 'Component.getRelationNodes': 'unsupported' } });
  const matrix = capabilityMatrix(lowered.manifest.capabilities);
  for (const name of names) {
    assert.equal(defaults.manifest.capabilities[name], 'partial');
    const expected = name === 'Component.getRelationNodes' ? 'unsupported' : 'partial';
    assert.equal(lowered.manifest.capabilities[name], expected);
    assert.equal(matrix.capabilities[name].status, expected);
    for (const host of matrix.hosts) assert.equal(matrix.capabilities[name].hosts[host], expected);
    assert.equal(matrix.capabilities[name].engines.quickjs, expected);
    assert.equal(matrix.capabilities[name].engines.v8, 'unsupported', 'the packer cannot assume a native V8 provider is linked');
  }
});

test('reference fixture has a committed deterministic manifest golden', async () => {
  const fixtureRoot = fileURLToPath(new URL('../../../fixtures/reference-app', import.meta.url));
  const goldenPath = new URL('./golden/reference-manifest.json', import.meta.url);
  const result = await buildManifest(fixtureRoot, { compilerCommit: 'golden-compiler-commit' });
  assert.equal(result.diagnostics.filter((item) => item.severity === 'error').length, 0);
  const expected = (await readFile(goldenPath, 'utf8')).trim();
  assert.equal(canonicalize(result.manifest), expected);
  assert.equal(result.manifest.integrity.root, JSON.parse(expected).integrity.root);
});

test('default packs admit system tab-bar transactions without claiming a default presenter', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'packed');
  await packContainer(root, output);
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  const matrix = JSON.parse(await readFile(path.join(output, 'capability-matrix.json'), 'utf8'));
  const names = [
    'wx.setTabBarBadge', 'wx.removeTabBarBadge', 'wx.showTabBarRedDot',
    'wx.hideTabBarRedDot', 'wx.setTabBarStyle',
  ];
  for (const name of names) {
    assert.equal(manifest.capabilities[name], 'partial');
    assert.equal(matrix.capabilities[name].status, 'partial');
    assert.ok(Object.values(matrix.capabilities[name].hosts).every(value => value === 'unsupported'));
  }
  for (const name of ['wx.showTabBar', 'wx.hideTabBar', 'wx.setTabBarItem']) {
    assert.equal(manifest.capabilities[name], undefined);
    assert.equal(matrix.capabilities[name], undefined);
  }
  const lowered = await buildManifest(root, {
    capabilities: Object.fromEntries(names.map(name => [name, 'unsupported'])),
  });
  for (const name of names) assert.equal(lowered.manifest.capabilities[name], 'unsupported');
});

test('buildManifest scans routes, modules, templates, styles and assets deterministically', async () => {
  const root = await fixture();
  const first = await buildManifest(root, { compilerCommit: 'abc123' });
  const second = await buildManifest(root, { compilerCommit: 'abc123' });
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.equal(first.manifest.schemaVersion, 1);
  assert.equal(first.manifest.compiler.commit, 'abc123');
  assert.equal(first.manifest.routes[0].kind, 'tab');
  assert.equal(first.manifest.routes[1].kind, 'subpage');
  assert.equal(first.manifest.routes[1].config, undefined);
  assert.ok(first.manifest.modules.some((item) => item.id === 'module:app.json'));
  assert.ok(first.manifest.modules.some((item) => item.id === 'module:components/hello/index.js' && item.scope === 'component'));
  assert.deepEqual(
    first.manifest.modules.find((item) => item.id === 'module:pages/home/index.js').dependencies,
    ['module:utils/shared.js'],
  );
  assert.deepEqual(first.manifest.components, [{
    id: 'components:pages/home/index.json',
    owner: 'pages/home/index.json',
    usingComponents: { hello: 'components/hello/index' },
  }]);
  assert.deepEqual(first.manifest.templates.find((item) => item.id === 'template:pages/home/index.wxml').bindings, ['title', 'user.name']);
  const template = first.manifest.templates.find((item) => item.id === 'template:pages/home/index.wxml');
  const templateBlob = first.blobs.get(template.wxmlAst.slice('sha256:'.length));
  assert.deepEqual(JSON.parse(templateBlob), parseWxml('<view>{{ title }} {{user.name}}</view>\n'));
  assert.equal(JSON.parse(templateBlob).nodes[0].children[0].bindings[0], 'title');
  const style = first.manifest.styles.find((item) => item.id === 'style:pages/home/index.wxss');
  const styleBlob = first.blobs.get(style.wxssIr.slice('sha256:'.length));
  assert.deepEqual(JSON.parse(styleBlob), parseWxss('.title { color: red; }\n'));
  assert.deepEqual(JSON.parse(styleBlob).rules[0].selectors, ['.title']);
  assert.equal(JSON.parse(styleBlob).rules[0].declarations[0].property, 'color');
  assert.equal(first.manifest.assets[0].sha256.length, 64);
  for (const [hash] of first.blobs) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.integrity.root, /^[a-f0-9]{64}$/);
});

test('buildManifest preserves component multipleSlots option for runtime projection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-container-slots-'));
  await mkdir(path.join(root, 'pages', 'index'), { recursive: true });
  await mkdir(path.join(root, 'components', 'card'), { recursive: true });
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }));
  await writeFile(path.join(root, 'app.js'), 'App({});');
  await writeFile(path.join(root, 'pages/index/index.js'), 'Page({});');
  await writeFile(path.join(root, 'pages/index/index.json'), JSON.stringify({
    usingComponents: { card: '../../components/card/index' },
  }));
  await writeFile(path.join(root, 'pages/index/index.wxml'), '<card><text slot="header">H</text><text>D</text></card>');
  await writeFile(path.join(root, 'components/card/index.js'), 'Component({ options: { multipleSlots: true } });');
  await writeFile(path.join(root, 'components/card/index.json'), JSON.stringify({ component: true }));
  await writeFile(path.join(root, 'components/card/index.wxml'), '<view><slot name="header"/><slot><text>fallback</text></slot></view>');
  const result = await buildManifest(root, { compilerCommit: 'abc123' });
  assert.equal(result.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.deepEqual(
    result.manifest.components.find((item) => item.owner === 'components/card/index.json'),
    {
      id: 'components:components/card/index.json',
      owner: 'components/card/index.json',
      usingComponents: {},
      multipleSlots: true,
    },
  );
});

test('pack preserves declared launch and subpackage order independently of lexical module inventory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-container-route-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pages = ['pages/z/index', 'pages/a/index'];
  const subPackages = [
    { root: 'pkg-z', pages: ['z/index', 'a/index'] },
    { root: 'pkg-a', pages: ['index'] },
  ];
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ pages, subPackages }));
  await writeFile(path.join(root, 'app.js'), 'App({});');
  const routes = [...pages, 'pkg-z/z/index', 'pkg-z/a/index', 'pkg-a/index'];
  for (const route of [...routes].reverse()) {
    await mkdir(path.dirname(path.join(root, route)), { recursive: true });
    await writeFile(path.join(root, `${route}.js`), 'Page({});');
    await writeFile(path.join(root, `${route}.wxml`), '<view/>');
  }
  const output = path.join(root, 'output');
  const packed = await packContainer(root, output, { compilerCommit: 'route-order-contract' });
  assert.deepEqual(packed.diagnostics.filter(item => item.severity === 'error'), []);
  const emitted = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(emitted.routes.map(route => route.path), routes);
  assert.deepEqual(emitted.routes.map(route => route.kind), ['page', 'page', 'subpage', 'subpage', 'subpage']);
  assert.equal(emitted.routes[0].entryModule, 'pages/z/index.js');
  assert.deepEqual(emitted.routes.map(route => route.entryModule), routes.map(route => `${route}.js`));
});

test('packContainer writes canonical manifest and content-addressed blobs', async () => {
  const root = await fixture();
  const output = path.join(root, 'artifacts');
  const result = await packContainer(root, output, { compilerCommit: 'abc123' });
  await writeFile(path.join(output, 'blobs', 'sha256', 'a'.repeat(64)), 'stale');
  await packContainer(root, output, { compilerCommit: 'abc123' });
  await assert.rejects(() => access(path.join(output, 'blobs', 'sha256', 'a'.repeat(64))));
  const manifestBytes = await readFile(path.join(output, 'manifest.json'), 'utf8');
  assert.equal(manifestBytes, `${canonicalize(result.manifest)}\n`);
  assert.equal(JSON.parse(manifestBytes).integrity.root, result.manifest.integrity.root);
  assert.equal(JSON.parse(await readFile(path.join(output, 'capability-matrix.json'))).schemaVersion, 1);
  assert.equal(JSON.parse(await readFile(path.join(output, 'diagnostics.json'))).diagnostics.length, 0);
  const second = await buildManifest(root, { compilerCommit: 'abc123' });
  assert.deepEqual(second.manifest, result.manifest, 'a nested output directory is excluded from a subsequent scan');
});

test('invalid app.json returns structured diagnostics and refuses writing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-container-invalid-'));
  await writeFile(path.join(root, 'app.json'), '{invalid');
  const result = await buildManifest(root);
  assert.ok(result.diagnostics.some((item) => item.code === 'ERR_INVALID_MANIFEST' && item.path === 'app.json'));
  const output = await mkdtemp(path.join(os.tmpdir(), 'weapp-container-invalid-out-'));
  await assert.rejects(() => packContainer(root, output), (error) => error.code === 'ERR_INVALID_MANIFEST');
});

test('invalid WXML and WXSS are reported before a pack can be written', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-container-invalid-markup-'));
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }));
  await mkdir(path.join(root, 'pages', 'index'), { recursive: true });
  await writeFile(path.join(root, 'pages', 'index', 'index.js'), 'Page({});');
  await writeFile(path.join(root, 'pages', 'index', 'index.wxml'), '<view><text></view>');
  await writeFile(path.join(root, 'pages', 'index', 'index.wxss'), '.bad { color }');
  const result = await buildManifest(root, { compilerCommit: 'abc123' });
  assert.ok(result.diagnostics.some((item) => item.path.endsWith('.wxml') && item.code === 'ERR_INVALID_MANIFEST'));
  assert.ok(result.diagnostics.some((item) => item.path.endsWith('.wxss') && item.code === 'ERR_INVALID_MANIFEST'));
  await assert.rejects(() => packContainer(root, path.join(root, 'out'), { compilerCommit: 'abc123' }), (error) => error.code === 'ERR_INVALID_MANIFEST');
});

test('capability matrix exposes stable host and engine records', () => {
  const matrix = capabilityMatrix({ 'wx.custom': 'partial' });
  assert.deepEqual(matrix.hosts, ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony']);
  assert.equal(matrix.capabilities['wx.custom'].status, 'partial');
  assert.deepEqual(Object.keys(matrix.capabilities['wx.custom'].hosts), matrix.hosts);
  assert.equal(matrix.capabilities['wx.custom'].hosts.web, 'partial');
  assert.equal(matrix.capabilities['wx.custom'].engines.v8, 'unsupported');
  assert.throws(() => capabilityMatrix({ 'wx.bad': 'sometimes' }), /Invalid capability status/);
});

test('account info advertises portable full support without overclaiming host evidence', () => {
  const matrix = capabilityMatrix();
  const account = matrix.capabilities['wx.getAccountInfoSync'];
  assert.equal(account.status, 'full');
  assert.deepEqual(
    Object.values(account.hosts),
    ['partial', 'partial', 'partial', 'partial', 'partial', 'partial', 'partial'],
  );
  assert.deepEqual(account.engines, { quickjs: 'full', v8: 'full' });
});

test('lowering account capability also lowers its derived coverage', () => {
  const matrix = capabilityMatrix({ 'wx.getAccountInfoSync': 'unsupported' });
  const account = matrix.capabilities['wx.getAccountInfoSync'];
  assert.equal(account.status, 'unsupported');
  assert.deepEqual(Object.values(account.hosts), [
    'unsupported', 'unsupported', 'unsupported', 'unsupported',
    'unsupported', 'unsupported', 'unsupported',
  ]);
  assert.deepEqual(account.engines, { quickjs: 'unsupported', v8: 'unsupported' });
});

test('invalid capability override is reported as a structured pack diagnostic', async () => {
  const root = await fixture();
  const result = await buildManifest(root, { capabilities: { 'wx.request': 'sometimes' } });
  assert.equal(result.manifest, null);
  assert.ok(result.diagnostics.some((item) => item.code === 'ERR_INVALID_CAPABILITY'));
});

test('extractStaticModuleSpecifiers ignores comments, strings and dynamic imports', () => {
  const source = `
    // require('./commented')
    const text = "import './in-string'";
    const cjs = require('./utils/shared');
    import value from './esm.mjs';
    import './side-effect.js';
    export { value } from './re-export.js';
    import('./dynamic.js');
  `;
  assert.deepEqual(extractStaticModuleSpecifiers(source), [
    './esm.mjs',
    './re-export.js',
    './side-effect.js',
    './utils/shared',
  ]);
});

test('static dependencies must resolve to emitted modules', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-container-dependency-'));
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ pages: [] }));
  await writeFile(path.join(root, 'app.js'), 'require("./missing");');
  const result = await buildManifest(root, { compilerCommit: 'abc123' });
  assert.ok(result.manifest);
  assert.ok(result.diagnostics.some((item) => item.code === 'ERR_UNDECLARED_MODULE_DEPENDENCY'));
  await assert.rejects(
    () => packContainer(root, path.join(root, 'out'), { compilerCommit: 'abc123' }),
    (error) => error.code === 'ERR_INVALID_MANIFEST',
  );
});

