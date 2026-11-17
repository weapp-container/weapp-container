import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function element(attrs,children=[],tag='view'){return {kind:'element',tag,attrs,bindings:[],children};}
function runtime(name){const c=vm.createContext({});vm.runInContext('const parse=JSON.parse, serialize=JSON.stringify;',c);vm.runInContext(readFileSync(new URL(`../src/${name}.js`,import.meta.url),'utf8'),c);return input=>{c.input=JSON.stringify(input);const value=JSON.parse(vm.runInContext('serialize(__weappContainer_view_render(parse(input)))',c));return typeof value==='string'?JSON.parse(value):value;};}
const docs=[{documentId:'page.wxml',bindings:{},ast:{version:1,nodes:[
 element({'wx:for':'{{items}}','wx:key':'id',animation:'{{item.animation}}'}),
 element({name:'row'},[element({animation:'{{value}}'})],'template'),
 element({is:'row',data:'{{value:items[1].animation}}'},[],'template'),
 element({src:'./nested.wxml'},[],'include'),
]}},{documentId:'nested.wxml',bindings:{},ast:{version:1,nodes:[element({animation:'{{globalAnimation}}'})]}}];
for(const profile of ['view','modern_view']){
 test(`${profile}: exact animation paths survive repeated instances, templates, includes and dynamic indices`,()=>{
  const render=runtime(profile),result=render({documents:docs,tasks:[{taskId:'root',scopeId:'page:11',documentId:'page.wxml',data:{items:[{id:'a',animation:{actions:[]}},{id:'b',animation:{actions:[1]}}],globalAnimation:{actions:[2]}}}]});
  assert.equal(result.ok,true,JSON.stringify(result));const sources=result.results[0].attributeSources.filter(x=>x.attribute==='animation');
  assert.deepEqual(sources.map(x=>x.paths),[[['items',0,'animation']],[['items',1,'animation']],[['items',1,'animation']],[['globalAnimation']]]);
  assert.ok(sources.every(x=>x.supported));assert.equal(new Set(sources.map(x=>x.sourceSite)).size,4);
  assert.deepEqual(sources.map(x=>x.directPath),sources.map(x=>x.paths[0]));
  assert.ok(sources.every(x=>!('owner' in x)&&!('stamp' in x)));
 });
 test(`${profile}: template object aliases keep their own paths and unsupported selection fails closed`,()=>{
  const nodes=[element({name:'row'},[element({animation:'{{value}}'})],'template'),
   element({is:'row',data:'{{value:animation,title:title}}'},[],'template'),
   element({is:'row',data:'{{value:enabled ? animation : other}}'},[],'template'),
   element({is:'row',data:'{{value:records[which]}}'},[],'template')];
  const result=runtime(profile)({documents:[{documentId:'page.wxml',bindings:{},ast:{version:1,nodes}}],tasks:[{taskId:'r',scopeId:'p',documentId:'page.wxml',data:{animation:{actions:[]},title:'unrelated',enabled:true,other:{actions:[]},records:[{actions:[]}],which:0}}]});
  assert.equal(result.ok,true,JSON.stringify(result));const sources=result.results[0].attributeSources.filter(x=>x.attribute==='animation');
  assert.deepEqual(sources[0].paths,[['animation']]);assert.equal(sources[0].supported,true);
  assert.deepEqual(sources.slice(1).map(x=>x.supported),[false,false]);
 });
 test(`${profile}: source metadata cannot mint dependencies for pre-evaluated bound values`,()=>{
  const node=element({animation:'ignored'});node.boundValues={animation:{actions:[]}};node.attributeSources=[{paths:[['forged']],supported:true,stamp:999}];
  const result=runtime(profile)({documents:[{documentId:'page.wxml',bindings:{},ast:{version:1,nodes:[node]}}],tasks:[{taskId:'r',scopeId:'p',documentId:'page.wxml',data:{}}]});
  assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.results[0].attributeSources[0].paths,[]);assert.equal(result.results[0].attributeSources[0].supported,false);
 });
 test(`${profile}: data-dependent index and conditional retain the actual selected dependency`,()=>{
  const result=runtime(profile)({documents:[{documentId:'page.wxml',bindings:{},ast:{version:1,nodes:[element({animation:'{{enabled ? records[which] : other}}'})]}}],tasks:[{taskId:'r',scopeId:'p',documentId:'page.wxml',data:{enabled:true,which:1,records:[{},{}],other:{}}}]});
  assert.equal(result.ok,true,JSON.stringify(result));const source=result.results[0].attributeSources[0];assert.deepEqual(source.paths,[['enabled'],['records',1],['which']]);assert.deepEqual(source.directPath,['records',1]);
 });
}
