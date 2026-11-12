// Freeze the public leaf surface from the exact, locked official typings.
// Usage: node scripts/generate-host-api-catalog.mjs /path/to/miniprogram-api-typings
import ts from 'typescript';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.argv[2] || 'vendor/weapp-vite/node_modules/miniprogram-api-typings');
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (pkg.version !== '5.2.3') throw new Error('Expected locked miniprogram-api-typings@5.2.3');
const baseline = '3.17.3';
const newer = (v) => v.split('.').map(Number).reduce((r, n, i) => r || Math.sign(n - Number(baseline.split('.')[i] || 0)), 0) > 0;
const runtimeGlobals = new Set(('onError offError onUnhandledRejection offUnhandledRejection onPageNotFound offPageNotFound onWindowResize offWindowResize onAppShow offAppShow onAppHide offAppHide onBeforePageUnload offBeforePageUnload onAfterPageUnload offAfterPageUnload onBeforeAppRoute offBeforeAppRoute onAppRoute offAppRoute rewriteRoute requestIdleCallback cancelIdleCallback navigateTo redirectTo reLaunch switchTab navigateBack getCurrentPages getAccountInfoSync getLaunchOptionsSync getEnterOptionsSync canIUse getLogManager getRandomValues nextTick getStorage getStorageSync setStorage setStorageSync removeStorage removeStorageSync clearStorage clearStorageSync getStorageInfo getStorageInfoSync batchGetStorageSync batchSetStorageSync batchGetStorage batchSetStorage createSelectorQuery createIntersectionObserver createAnimation createMediaQueryObserver getMenuButtonBoundingClientRect setNavigationBarTitle setNavigationBarColor showNavigationBarLoading hideNavigationBarLoading setBackgroundColor setBackgroundTextStyle setTabBarItem setTabBarStyle showTabBar hideTabBar showTabBarRedDot hideTabBarRedDot setTabBarBadge removeTabBarBadge pageScrollTo startPullDownRefresh stopPullDownRefresh arrayBufferToBase64 base64ToArrayBuffer createBufferURL revokeBufferURL').split(' '));
const runtimeObjects = new Set(['SelectorQuery', 'NodesRef', 'IntersectionObserver', 'MediaQueryObserver', 'Animation', 'EventChannel', 'LogManager']);
const snapshots = new Set(('getAccountInfoSync getSystemInfoSync getWindowInfo getDeviceInfo getAppBaseInfo getSystemSetting getAppAuthorizeSetting getRendererUserAgent getSkylineInfoSync getBatteryInfoSync getNetworkTypeSync getLocalIPAddressSync').split(' '));
// These legacy conversion functions return values directly despite lacking a
// Sync suffix. Keep their execution class tied to the locked public signature.
const localSynchronous = new Set(['arrayBufferToBase64', 'base64ToArrayBuffer', 'createBufferURL', 'revokeBufferURL']);
const permission = (path) => {
  for (const [part, name] of [['bluetooth','bluetooth'],['ibeacon','location'],['location','location'],['camera','camera'],['record','microphone'],['contact','contacts'],['calendar','calendar'],['clipboard','clipboard'],['nfc','nfc'],['wifi','wifi'],['sensor','sensors'],['soter','biometrics'],['user-info','profile'],['login','account'],['payment','payment']]) if (path.toLowerCase().includes(part)) return name;
};
const entries = new Map(), globalProperties = new Map(), sources = [], declarations = [];
for (const filename of (await readdir(join(source, 'types/wx'))).filter(f => f.endsWith('.d.ts')).sort()) {
  const path = join(source, 'types/wx', filename);
  const text = await readFile(path, 'utf8');
  sources.push({ path: relative(source, path), sha256: createHash('sha256').update(text).digest('hex') });
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  declarations.push(ast);
}
const objectTypes = new Set();
for (const ast of declarations) {
  const collect = node => {
    if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name &&
      node.members.some(m => (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) && /developers\.weixin\.qq\.com\/miniprogram\/dev\/api\//.test(m.getFullText(ast)))) objectTypes.add(node.name.text);
    ts.forEachChild(node,collect);
  };
  collect(ast);
}
for (const ast of declarations) {
  const visit = (node) => {
    if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const type = node.name.text;
      const isGlobal = type === 'Wx';
      const hasPublicMethods = isGlobal || node.members.some(m => (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) && /developers\.weixin\.qq\.com\/miniprogram\/dev\/api\//.test(m.getFullText(ast)));
      if (hasPublicMethods) for (const member of node.members) {
        if (isGlobal && member.name && ts.isPropertySignature(member)) {
          const propertyName = member.name.getText(ast).replace(/^['"]|['"]$/g, '');
          globalProperties.set(`wx.${propertyName}`, {name:`wx.${propertyName}`,type:member.type?.getText(ast)||'unknown',callable:false,
            owner:['env','router','worklet'].includes(propertyName)?'runtime':'host',
            ...(propertyName==='env'?{properties:[{name:'USER_DATA_PATH',kind:'syncSnapshot',writable:false,managedPath:true}]}:{})});
        }
        if (!member.name || !(ts.isMethodSignature(member) || ts.isMethodDeclaration(member) || (!isGlobal && ts.isPropertySignature(member)))) continue;
        const memberName = member.name.getText(ast).replace(/^['"]|['"]$/g, '');
        const comment = (member.jsDoc || []).map(d => d.getText(ast)).join('\n');
        const doc = comment.match(/https:\/\/developers\.weixin\.qq\.com\/miniprogram\/dev\/api\/[^\s)]+/)?.[0];
        const minVersion = comment.match(/需要基础库[：:]\s*`([\d.]+)`/)?.[1];
        // Newer entries are retained as excluded so a newer typings release can
        // never silently increase the 3.17.3 compatibility promise.
        const inBaseline = !minVersion || !newer(minVersion);
        const name = isGlobal ? `wx.${memberName}` : `object:${type}.${memberName}`;
        const returns = member.type?.getText(ast) || 'void';
        const params = member.parameters?.map(p => ({name:p.name.getText(ast),type:p.type?.getText(ast)||'unknown',optional:!!p.questionToken})) || [];
        const isProperty = ts.isPropertySignature(member);
        const writable = isProperty && !member.modifiers?.some(m=>m.kind===ts.SyntaxKind.ReadonlyKeyword) && !/只读|\bread[- ]?only\b/i.test(comment);
        const returnName = returns.replace(/^WechatMiniprogram\./, '').replace(/<.*>$/, '');
        const objectType = !isProperty && objectTypes.has(returnName) ? returnName : undefined;
        let kind = memberName.startsWith('on') || memberName.startsWith('off') ? 'subscription' : snapshots.has(memberName) ? 'syncSnapshot' : memberName.endsWith('Sync') || isProperty || isGlobal && localSynchronous.has(memberName) ? 'syncLocal' : objectType ? (/Task$/.test(objectType)?'task':'object') : 'async';
        const owner = (isGlobal ? runtimeGlobals.has(memberName) : runtimeObjects.has(type)) ? 'runtime' : 'host';
        if (isGlobal && kind === 'object') kind = /Task$/.test(objectType) ? 'task' : 'object';
        const entry = {name,kind,owner,...(permission(doc||'')?{permission:permission(doc||'')}:{}),...(objectType?{objectType}:{}),...(!isGlobal?{receiver:type}:{}),...(isProperty?{property:true,writable,access:{read:'snapshot',write:writable?'command':'none'}}:{}),...(memberName.startsWith('on')?{event:memberName.slice(2),counterpart:name.replace(/\.on/,'.off')}:memberName.startsWith('off')?{event:memberName.slice(3),counterpart:name.replace(/\.off/,'.on')}:{}),baseline:inBaseline?'included':'newer-than-baseline',...(minVersion?{since:minVersion}:{}),...(doc?{documentation:doc}:{}),signatures:[{parameters:params,returns}]};
        const previous = entries.get(name);
        if(previous) previous.signatures.push(...entry.signatures); else entries.set(name,entry);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
for (const [name,kind,perm] of [
  ['weappContainer.identity.getState','syncSnapshot','account'],
  ['weappContainer.identity.onChange','subscription','account'],
  ['weappContainer.identity.offChange','subscription','account'],
  ['weappContainer.identity.logout','async','account'],
  ['weappContainer.identity.authorizePhone','async','phone'],
  ['weappContainer.payment.request','async','payment'],
]) entries.set(name,{name,kind,owner:'host',permission:perm,baseline:'extension'});
for (const [name,kind,permission] of [
  ['component:button.open-type.getPhoneNumber','async','phone'],
  ['component:button.bindgetphonenumber','subscription','phone'],
  ['component:camera','object','camera'],
  ['component:video','object','media'],
  ['component:audio','object','media'],
  ['component:live-player','object','media'],
  ['component:live-pusher','object','camera'],
  ['component:map','object','location'],
]) entries.set(name,{name,kind,owner:'runtime',permission,baseline:'included',documentation:'https://developers.weixin.qq.com/miniprogram/dev/component/'+name.split(':')[1].split('.')[0]+'.html',component:true});
const apis = [...entries.values()].sort((a,b)=>a.name.localeCompare(b.name,'en'));
const catalog = {schemaVersion:1,protocolVersion:'1.0',baseline:{baseLibrary:baseline,typings:{name:pkg.name,version:pkg.version,sources}},globalProperties:[...globalProperties.values()].sort((a,b)=>a.name.localeCompare(b.name,'en')),apis};
await writeFile(join(root,'crates/container-runtime/src/host-api-catalog.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(JSON.stringify({apis:apis.length,globals:apis.filter(a=>a.name.startsWith('wx.')).length,objects:apis.filter(a=>a.name.startsWith('object:')).length,newer:apis.filter(a=>a.baseline==='newer-than-baseline').length}));
