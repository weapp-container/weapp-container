/** Independent source AST/static contracts. Synthetic bytes are never compiler output. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'
import { descriptor as issue547 } from '../../../conformance/recipes/issue547-descriptor.mjs'
import { descriptor as issue289 } from '../../../conformance/recipes/issue289-descriptor.mjs'
import { assertIssue547StaticOutputs } from './issue547-static.mjs'
import { assertIssue289StaticOutputs } from './issue289-static.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const walk=(node,fn)=>{fn(node);ts.forEachChild(node,child=>walk(child,fn))}
async function source(descriptor) {const bytes=await readFile(new URL('../../../vendor/weapp-vite/'+descriptor.caseSourcePath,import.meta.url));return{bytes,ast:ts.createSourceFile('original.ts',bytes.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)}}
function staticClauses(ast) {
 const clauses=[],inputs={}
 walk(ast,node=>{
  if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isAwaitExpression(node.initializer)&&ts.isCallExpression(node.initializer.expression)) {
   const call=node.initializer.expression;if(['readDistFile','readDistWxml'].includes(call.expression.getText(ast)))inputs[node.name.getText(ast)]=call.arguments[0].text
  }
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='toContain'){
   const expect=node.expression.expression;assert(ts.isCallExpression(expect));assert.equal(expect.expression.getText(ast),'expect');const path=inputs[expect.arguments[0].getText(ast)];assert(path);assert(ts.isStringLiteralLike(node.arguments[0]));clauses.push({path,literal:node.arguments[0].text})
  }
 });return clauses
}
function staticInput(descriptor,clauses) {return{caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256,files:descriptor.compiledFiles.map(path=>{const bytes=Buffer.from(clauses.filter(c=>c.path===path).map(c=>c.literal).join('\n'));return{path,bytes,length:bytes.length,sha256:hash(bytes)}})}}
for(const [descriptor,assertStatic,count]of [[issue547,assertIssue547StaticOutputs,5],[issue289,assertIssue289StaticOutputs,28]]) {
 test(descriptor.caseId+' retains every original it and static expectation',async()=>{
  const {ast,bytes}=await source(descriptor);assert.equal(hash(bytes),descriptor.sourceSha256)
  const titles=[];let suite;walk(ast,n=>{if(ts.isCallExpression(n)&&n.expression.getText(ast)==='describe')suite=n.arguments[0].text;if(ts.isCallExpression(n)&&n.expression.getText(ast)==='it')titles.push(n.arguments[0].text)})
  assert.deepEqual(descriptor.plans.map(p=>p.fullName),titles.map(title=>suite+' '+title))
  const clauses=staticClauses(ast);assert.equal(clauses.length,count);const input=staticInput(descriptor,clauses);assert.equal(assertStatic(input).originalStaticExpectations,count)
  for(const clause of clauses){const changed=structuredClone(input);changed.files=changed.files.map(file=>{const bytes=file.path===clause.path?Buffer.from(Buffer.from(file.bytes).toString().replaceAll(clause.literal,'')):Buffer.from(file.bytes);return{...file,bytes,length:bytes.length,sha256:hash(bytes)}});assert.throws(()=>assertStatic(changed),undefined,'source assertion '+JSON.stringify(clause))}
  for(const mutate of [v=>v.files.pop(),v=>v.files.push(v.files[0]),v=>v.files.reverse(),v=>v.sourceSha256='0'.repeat(64),v=>v.caseId='another-source']){const changed=staticInput(descriptor,clauses);mutate(changed);assert.throws(()=>assertStatic(changed))}
 })
 test(descriptor.caseId+' descriptor carries addresses and field names only',()=>{
  for(const plan of descriptor.plans)for(const step of plan.steps)if(step.kind==='checkpoint')for(const query of step.queries){assert(Object.keys(query).every(k=>['selector','query','scope','has','fields'].includes(k)));assert.deepEqual(Object.keys(query.fields).sort(),['attributes','text']);assert.equal(typeof query.fields.text,'boolean');assert.deepEqual(query.fields.attributes,[]);assert(!Object.hasOwn(query,'count'))}
 })
}
test('all imported issue289 source plans map to all16 checkpoints and12 actual tap addresses',async()=>{
 const original=await readFile(new URL('../../../vendor/weapp-vite/e2e/ide/githubIssuesDom/classes.ts',import.meta.url),'utf8')
 const ast=ts.createSourceFile('classes.ts',original,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 const statements=ast.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(ast)).join('\n')
 const javascript=ts.transpileModule(statements,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const exports={};vm.runInNewContext(javascript,{exports,text:(selector,text,scope)=>({selector,text,...(scope?{scope}:{})})})
 const sets=['OBJECT_CLASSES','MAP_CLASSES','ROOT_CLASSES','COMPUTED_CLASSES'];let checkpoints=0,taps=0
 for(const [ordinal,name]of sets.entries()) {
  const plan=issue289.plans[ordinal],steps=JSON.parse(JSON.stringify(exports[name]));let at=0
  for(const original of steps){if(original.tap){const action=plan.steps[at++];assert.equal(action.kind,'tap');assert.equal(action.address.selector,original.tap);taps++}const actual=plan.steps[at++];assert.equal(actual.kind,'checkpoint');assert.equal(actual.id,original.id);assert.deepEqual(actual.queries,original.nodes.map(n=>({selector:n.selector,query:'css',...(n.scope?{scope:n.scope}:{}),fields:{text:n.text!==undefined,attributes:[]}})));checkpoints++}assert.equal(at,plan.steps.length)
 }assert.equal(checkpoints,16);assert.equal(taps,12)
})
test('issue547 keeps exact five-step nested component scope and actual marker address',()=>{
 assert.deepEqual(issue547.plans[0].steps[0].queries[1].scope,['#issue547-group',{has:'#issue547-cell'},'#issue547-cell',{has:'#issue547-image'},'#issue547-image'])
 assert.deepEqual(issue547.plans[0].readiness,{selector:'#issue547-page',attributes:['data-e2e-issue']})
})

test('issue547 inline original AST retains both exact selectors, scopes and selected fields', async () => {
  const { ast } = await source(issue547)
  let expression
  walk(ast, node => { if (ts.isCallExpression(node) && node.expression.getText(ast) === 'createDomAcceptance') expression = node.arguments[2].getText(ast) })
  assert(expression)
  const javascript = ts.transpileModule('exports.plans = ' + expression, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}; vm.runInNewContext(javascript, { exports })
  const original = JSON.parse(JSON.stringify(exports.plans)); assert.equal(original.length, 1)
  const actual = issue547.plans[0].steps[0]
  assert.equal(actual.id, original[0].id); assert.equal(issue547.plans[0].route, original[0].route.slice(1))
  assert.deepEqual(actual.queries, original[0].nodes.map(node => ({ selector: node.selector, query: 'css', scope: node.scope, fields: { text: node.text !== undefined, attributes: [] } })))
})
