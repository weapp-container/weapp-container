import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {isBuiltin} from 'node:module'
import ts from 'typescript'
import {descriptor} from './issue941-descriptor.mjs'
import {readConformanceRecipes} from '../../scripts/conformance-recipes.mjs'
import {createDriverRegistry} from '../../examples/hosts/conformance-desktop/driver-registry.mjs'
import {githubProducerCase,githubProducerInvocation} from '../../scripts/conformance-github-producer.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url)),vendor=fileURLToPath(new URL('../../vendor/weapp-vite',import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const original=()=>execFileSync('rtk',['proxy','git','-C',vendor,'show','HEAD:'+descriptor.caseSourcePath])
test('descriptor binds unchanged pinned source, all original checkpoints and exact explicit method options',()=>{
 const bytes=original();assert.equal(sha(bytes),descriptor.sourceSha256);for(const guard of descriptor.sourceGuards)assert.equal(sha(execFileSync('rtk',['proxy','git','-C',vendor,'show','HEAD:'+guard.path])),guard.sha256)
 const tree=ts.createSourceFile(descriptor.caseSourcePath,bytes.toString(),ts.ScriptTarget.Latest,true),methods=[]
 const visit=node=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='callMethodWithOptions')methods.push(node);ts.forEachChild(node,visit)};visit(tree);assert.equal(methods.length,1);assert.equal(methods[0].getText(tree),"page.callMethodWithOptions('_runE2E', { timeout: 8_000 })");assert.equal(tree.getLineAndCharacterOfPosition(methods[0].getStart(tree)).line+1,89)
 assert.deepEqual(descriptor.plans[0].steps.map(step=>step.kind),['checkpoint','method.call','checkpoint']);assert.deepEqual(descriptor.plans[0].steps[1].callOptions,{timeout:8000});assert.deepEqual(descriptor.plans[0].steps[1].args,[]);assert.deepEqual(descriptor.compiledFiles,['pages/issue-941/index.js','pages/issue-941/index.json','pages/issue-941/index.wxml']);assert.deepEqual(descriptor.plans[0].steps.filter(step=>step.kind==='checkpoint').map(step=>step.queries.length),[4,24])
})
test('recipe and every transitive collector module are exact explicit source inputs',async()=>{
 const index=JSON.parse(readFileSync(new URL('../../docs/conformance/case-index-v1.json',import.meta.url))),recipes=await readConformanceRecipes({root,index,file:fileURLToPath(new URL('./issue941-v1.json',import.meta.url))});assert.equal(recipes.size,1);const recipe=recipes.get(descriptor.caseId),refs=[recipe.collector,...recipe.collectorInputs],allowed=new Set(refs.map(ref=>new URL('../../'+ref.path,import.meta.url).href))
 for(const ref of refs){const url=new URL('../../'+ref.path,import.meta.url),bytes=readFileSync(url),tree=ts.createSourceFile(ref.path,bytes.toString(),ts.ScriptTarget.Latest,true);assert.equal(sha(bytes),ref.sha256);assert.equal(bytes.length,ref.bytes);for(const node of tree.statements)if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){const spec=node.moduleSpecifier.text;assert.ok(isBuiltin(spec)||allowed.has(new URL(spec,url).href),spec)}}
 assert.ok(githubProducerCase(descriptor));assert.equal(githubProducerCase({...descriptor,sourceSha256:'0'.repeat(64)}),null)
})
test('explicit macos/linux and dual engine drivers include all source dependencies with no missing or duplicate pair',async()=>{const registry=await createDriverRegistry(root,{hosts:['macos','linux']});assert.deepEqual(registry.drivers.map(driver=>driver.host+'/'+driver.engine),['macos/quickjs','macos/v8','linux/quickjs','linux/v8']);for(const driver of registry.drivers){const all=[driver.module,...driver.inputs];assert.equal(new Set(all.map(ref=>ref.path)).size,all.length);for(const ref of all)assert.equal(sha(readFileSync(new URL('../../'+ref.path,import.meta.url))),ref.sha256)}})
