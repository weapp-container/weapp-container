import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  archiveCompilerBuildBytes, buildCompilerFromPinnedSource, inspectCompilerBuildEvidence,
  requireCompilerBuildEvidence, compilerBuildWorkspaceManifests, compilerBuildEnvironment,
} from './conformance-compiler-build.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
test('nested task package-manager lookup uses the pinned tool before a Node Corepack shim', async t=>{
  const root=await mkdtemp(join(tmpdir(),'conformance-compiler-manager-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const manager=join(root,'pinned-manager'),nodeBin=join(root,'node-bin')
  await mkdir(manager);await mkdir(nodeBin)
  await writeFile(join(manager,'pnpm-native'),'owned native manager')
  await writeFile(join(manager,'pnpm'),'#!/bin/sh\nprintf "12.11.2\\n"\n',{mode:0o755})
  await writeFile(join(nodeBin,'pnpm'),'#!/bin/sh\nprintf "12.18.0\\n"\n',{mode:0o755})
  const env=compilerBuildEnvironment(join(manager,'pnpm-native'),join(nodeBin,'node'))
  const result=execFileSync(process.execPath,['--input-type=module','-e',
    "import {execFileSync} from 'node:child_process';process.stdout.write(execFileSync('pnpm',['--version'],{encoding:'utf8'}))"],{env,encoding:'utf8'})
  assert.equal(result,'12.11.2\n')
  assert.equal(env.NODE_OPTIONS,'');assert.equal(env.NODE_PATH,'')
})

async function fixture(t, { installExtra = '', buildExtra = '', buildSource } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conformance-compiler-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), directory = join(root, 'archive'), checkout = join(root, 'owned-checkout')
  await mkdir(join(source, 'packages/workspace'), { recursive: true })
  const files = {
    '.gitignore':'node_modules/\ndist/\n',
    'package.json':JSON.stringify({name:'synthetic-executable-compiler-fixture',version:'1.0.0',type:'module',packageManager:`node@${process.versions.node}`,
      dependencies:{'@fixture/workspace':'workspace:*','fixture-external':'1.0.0'}}),
    'packages/workspace/package.json':JSON.stringify({name:'@fixture/workspace',version:'1.0.0',type:'module',exports:'./index.mjs'}),
    'packages/workspace/index.mjs':"export const answer=42;\n",
    'pnpm-workspace.yaml':"packages:\n  - packages/*\n  - '!packages/**/test/**'\n",
    'fixture-lock.json':JSON.stringify({syntheticFixture:true,dependencies:{'fixture-external':'1.0.0'}}),
    'install.mjs':`import{mkdir,writeFile,symlink}from'node:fs/promises';
      await mkdir('node_modules/@fixture',{recursive:true});await symlink('../../packages/workspace','node_modules/@fixture/workspace');
      await mkdir('node_modules/fixture-external',{recursive:true});
      await writeFile('node_modules/fixture-external/package.json',JSON.stringify({name:'fixture-external',version:'1.0.0',type:'module',exports:'./index.mjs'}));
      await writeFile('node_modules/fixture-external/index.mjs','export const suffix="fresh";');
      await writeFile('node_modules/fixture-external/tool','#!/bin/sh\\nexit 0\\n',{mode:0o755});
      process.stdout.write('actual synthetic fixture dependency installation\\n');${installExtra}`,
    'build.mjs': buildSource ?? `import{mkdir,writeFile}from'node:fs/promises';import{answer}from'@fixture/workspace';import{suffix}from'fixture-external';
      await mkdir('dist',{recursive:true});await writeFile('dist/index.mjs','// built by actual Node fixture child\\nexport const value='+JSON.stringify(answer+'/'+suffix)+';\\n');
      process.stdout.write('actual synthetic fixture build\\n');${buildExtra}`,
  }
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(source, path), bytes)
  execFileSync('git', ['init','--quiet'], {cwd:source})
  execFileSync('git', ['add','.'], {cwd:source})
  execFileSync('git', ['-c','user.name=Conformance Test','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','synthetic executable build fixture'], {cwd:source})
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim()
  const options={root,source,directory,checkout,commit,profile:'compiler-fixture-v1',
    fixtureCommands:{install:[process.execPath,'install.mjs'],build:[process.execPath,'build.mjs']},fixtureOutputDirectories:['dist'],fixtureRequiredOutputs:['dist/index.mjs']}
  const inspect = reference => inspectCompilerBuildEvidence({root,reference,expectedCommit:commit,expectedProfile:'compiler-fixture-v1'})
  const put = bytes => archiveCompilerBuildBytes({root,directory,bytes})
  const repack = attestation => put(JSON.stringify(attestation,null,2)+'\n')
  return {root,source,directory,checkout,commit,options,inspect,put,repack}
}

test('owned detached fresh build records real child processes and verifies after checkout cleanup', async t=>{
  const f=await fixture(t)
  // Ignored source dist is deliberately ignored by the fresh Git clone.
  await mkdir(join(f.source,'dist'));await writeFile(join(f.source,'dist/borrowed.mjs'),'unverified old vendor dist')
  const result=await buildCompilerFromPinnedSource({...f.options,keepCheckout:false})
  assert.equal(existsSync(f.checkout),false)
  assert.equal(result.attestation.status,'built')
  assert.equal(result.attestation.outputs.some(item=>item.path==='dist/borrowed.mjs'),false)
  const checked=f.inspect(result.reference)
  assert.deepEqual(checked.errors,[])
  assert.ok(checked.artifactReferences.length>10)
  assert.match(readFileSync(join(f.root,result.attestation.build.commands[1].stdout.path),'utf8'),/actual synthetic fixture build/)
  assert.match(readFileSync(join(f.root,result.attestation.outputs[0].artifact.path),'utf8'),/42\/fresh/)
  assert.equal(result.attestation.dependencies.resolutions.length,2)
  const inventory=JSON.parse(readFileSync(join(f.root,result.attestation.dependencies.inventory.path)))
  assert.ok(inventory.entries.filter(item=>item.kind==='file').every(item=>typeof item.executable==='boolean'))
  assert.equal(inventory.entries.find(item=>item.path==='node_modules/fixture-external/tool').executable,true)
  assert.match(inspectCompilerBuildEvidence({root:f.root,reference:result.reference,expectedCommit:f.commit}).errors[0],/unapproved build profile/)
})

test('retained dist labels and wrong pins cannot satisfy formal provenance', async t=>{
  const f=await fixture(t)
  const diagnostic=f.put(JSON.stringify({schemaVersion:1,retainedBuildProvenance:'verified',fresh:true,diagnosticOnly:false}))
  assert.match(f.inspect(diagnostic).errors[0],/unsupported compiler build attestation/)
  assert.match(inspectCompilerBuildEvidence({root:f.root,reference:null,expectedCommit:f.commit}).errors[0],/required/)
  const result=await buildCompilerFromPinnedSource(f.options)
  assert.match(inspectCompilerBuildEvidence({root:f.root,reference:result.reference,expectedCommit:'1'.repeat(40),expectedProfile:'compiler-fixture-v1'}).errors[0],/differs from.*Git pin/)
})

test('dirty tracked and assume-unchanged source are rejected before any build',async t=>{
  for(const hidden of [false,true]){
    const f=await fixture(t)
    if(hidden)execFileSync('git',['update-index','--assume-unchanged','build.mjs'],{cwd:f.source})
    await writeFile(join(f.source,'build.mjs'),'throw new Error("dirty");')
    await assert.rejects(buildCompilerFromPinnedSource(f.options),/dirty compiler source/)
  }
})

test('borrowed dependency symlink escapes are rejected with a failed archived receipt',async t=>{
  const f=await fixture(t,{installExtra:"await symlink('../..','node_modules/borrowed-vendor');"})
  await assert.rejects(buildCompilerFromPinnedSource(f.options),error=>{
    assert.match(error.message,/dependency symlink escapes/)
    assert.ok(error.compilerBuild)
    assert.match(f.inspect(error.compilerBuild).errors[0],/failed, diagnostic/)
    return true
  })
})

test('tracked node_modules fixtures stay in the source closure and cannot be shadowed by install evidence',async t=>{
  const member='packages/workspace/test/fixture/node_modules/source-pkg/index.mjs'
  for(const mutate of [false,true]){
    const f=await fixture(t,{buildExtra:mutate?`await writeFile('${member}','changed');`:
      `await writeFile('dist/source-fixture.mjs',(await import('./${member}')).source);`})
    await mkdir(join(f.source,'packages/workspace/test/fixture/node_modules/source-pkg'),{recursive:true})
    await writeFile(join(f.source,member),'export const source="tracked source fixture";\n')
    execFileSync('git',['add','--force',member],{cwd:f.source})
    execFileSync('git',['-c','user.name=Conformance Test','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','tracked dependency fixture'],{cwd:f.source})
    const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:f.source,encoding:'utf8'}).trim()
    if(mutate){await assert.rejects(buildCompilerFromPinnedSource({...f.options,commit}),/dirty compiler source/);continue}
    const result=await buildCompilerFromPinnedSource({...f.options,commit})
    assert.ok(result.attestation.source.files.some(file=>file.path===member))
    const inventory=JSON.parse(readFileSync(join(f.root,result.attestation.dependencies.inventory.path)))
    assert.equal(inventory.entries.some(file=>file.path===member),false)
    const source=result.attestation.source.files.find(file=>file.path===member)
    inventory.entries.push({path:member,kind:'file',executable:false,artifact:source.artifact})
    const changed=structuredClone(result.attestation)
    changed.dependencies.inventory=f.put(JSON.stringify(inventory))
    assert.match(inspectCompilerBuildEvidence({root:f.root,reference:f.repack(changed),expectedCommit:commit,expectedProfile:'compiler-fixture-v1'}).errors[0],/source-shadowing/)
  }
})

test('installation cannot prepopulate compiler outputs and no-op builds cannot reuse them',async t=>{
  for(const variant of ['install-output','no-output']){
    const f=await fixture(t,variant==='install-output'?{installExtra:"await mkdir('dist');await writeFile('dist/index.mjs','old');"}:{buildSource:"process.stdout.write('no compiler output');"})
    await assert.rejects(buildCompilerFromPinnedSource(f.options),/installation produced compiler outputs|required entry outputs/)
  }
})

test('build failure, source mutation and dependency mutation stay unverified',async t=>{
  for(const variant of ["process.exit(7);","await writeFile('packages/workspace/index.mjs','changed');","await writeFile('node_modules/fixture-external/index.mjs','changed');"]){
    const f=await fixture(t,{buildExtra:variant})
    await assert.rejects(buildCompilerFromPinnedSource(f.options),error=>{
      assert.ok(error.compilerBuild)
      const value=JSON.parse(readFileSync(join(f.root,error.compilerBuild.path)))
      assert.equal(value.status,'failed')
      assert.equal(f.inspect(error.compilerBuild).errors.length,1)
      return true
    })
  }
})

test('offline reader rejects missing source closure, forged commands and tampered outputs',async t=>{
  const f=await fixture(t), result=await buildCompilerFromPinnedSource(f.options)
  for(const mutate of [
    a=>{a.source.files.pop()},
    a=>{a.build.commands[1].exitCode=7},
    a=>{a.build.commands[1].execution=a.build.commands[0].execution},
    a=>{a.outputs[0].path='borrowed/dist/index.mjs'},
    a=>{a.outputs[0].artifact.sha256='a'.repeat(64)},
    a=>{a.build.environment.NODE_PATH='/borrowed/vendor/node_modules'},
    a=>{a.build.before=a.build.after},
  ]){
    const changed=structuredClone(result.attestation);mutate(changed)
    assert.notDeepEqual(f.inspect(f.repack(changed)).errors,[])
  }
  assert.deepEqual(f.inspect(result.reference).errors,[])
})

test('dependency inventory, direct resolution omissions, duplicates and wrong versions fail closed',async t=>{
  const f=await fixture(t), result=await buildCompilerFromPinnedSource(f.options)
  for(const mutate of [
    a=>{a.dependencies.resolutions=[]},
    a=>{a.dependencies.resolutions.push(a.dependencies.resolutions[0])},
    a=>{a.dependencies.resolutions[0].range='workspace:^'},
    a=>{a.dependencies.resolutions[0].version='99.0.0'},
    a=>{a.dependencies.resolutions[0].missing=true;a.dependencies.resolutions[0].packageJson=null},
    a=>{const inventory=JSON.parse(readFileSync(join(f.root,a.dependencies.inventory.path)));inventory.entries=[];a.dependencies.inventory=f.put(JSON.stringify(inventory))},
    a=>{const inventory=JSON.parse(readFileSync(join(f.root,a.dependencies.inventory.path)));inventory.entries.find(item=>item.kind==='link').target='../vendor';a.dependencies.inventory=f.put(JSON.stringify(inventory))},
  ]){
    const changed=structuredClone(result.attestation);mutate(changed)
    assert.notDeepEqual(f.inspect(f.repack(changed)).errors,[])
  }
})

test('archive paths and symlinked references cannot escape the evidence root',async t=>{
  const f=await fixture(t), result=await buildCompilerFromPinnedSource(f.options)
  assert.match(f.inspect({...result.reference,path:'../outside.json'}).errors[0],/unsafe archive/)
  await symlink(join(f.root,result.reference.path),join(f.root,'linked-attestation.json'))
  assert.match(f.inspect({...result.reference,path:'linked-attestation.json'}).errors[0],/not a regular file/)
  let loads=0
  const checked=inspectCompilerBuildEvidence({root:f.root,reference:result.reference,expectedCommit:f.commit,expectedProfile:'compiler-fixture-v1',
    loadArtifact(reference,label,json){loads++;assert.equal(json,false);return readFileSync(join(f.root,reference.path))}})
  assert.deepEqual(checked.errors,[]);assert.ok(loads>10)
  assert.throws(()=>requireCompilerBuildEvidence({root:f.root,reference:result.reference,expectedCommit:'f'.repeat(40)}),/unapproved build profile|Git pin/)
})

test('workspace membership excludes nested test fixtures without widening package patterns',()=>{
  const source=[{path:'package.json'},{path:'pnpm-workspace.yaml'},{path:'packages/core/package.json'},{path:'packages/core/test/fixture/package.json'}]
  const read=file=>file.path==='pnpm-workspace.yaml'?Buffer.from("packages:\n  - packages/**\n  - '!packages/**/test/**'\n"):Buffer.from('{}')
  assert.deepEqual(compilerBuildWorkspaceManifests(source,read).map(file=>file.path),['package.json','packages/core/package.json'])
})


test('owned build timeout escalates its own process group and writes the terminal receipt',async t=>{
  const f=await fixture(t,{buildSource:"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"})
  const start=Date.now()
  await assert.rejects(buildCompilerFromPinnedSource({...f.options,timeoutMs:250}),error=>{
    const receipt=JSON.parse(readFileSync(join(f.root,error.compilerBuild.path)))
    assert.equal(receipt.status,'failed')
    assert.equal(receipt.build.commands.at(-1).phase,'build')
    assert.equal(receipt.build.commands.at(-1).signal,'timeout')
    return true
  })
  assert.ok(Date.now()-start<15_000,'owned SIGKILL must bound a SIGTERM-ignoring child')
})


test('pinned built-in CRLF checkout transforms remain bound to the raw Git source',async t=>{
  const f=await fixture(t)
  await writeFile(join(f.source,'.gitattributes'),'*.ps1 text eol=crlf\n')
  await writeFile(join(f.source,'windows.ps1'),'Write-Host "synthetic compiler fixture"\n')
  execFileSync('git',['add','.gitattributes','windows.ps1'],{cwd:f.source,stdio:'ignore'})
  execFileSync('git',['-c','user.name=Conformance Test','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','pinned checkout attributes'],{cwd:f.source})
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:f.source,encoding:'utf8'}).trim()
  const result=await buildCompilerFromPinnedSource({...f.options,commit})
  assert.equal(result.attestation.source.checkoutTransforms[0].path,'windows.ps1')
  assert.equal(result.attestation.source.checkoutTransforms[0].kind,'git-text-crlf')
  assert.deepEqual(inspectCompilerBuildEvidence({root:f.root,reference:result.reference,expectedCommit:commit,expectedProfile:'compiler-fixture-v1'}).errors,[])
})
