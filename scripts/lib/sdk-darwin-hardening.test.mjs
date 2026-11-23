import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { hardenDarwinStaticArchive, inspectDarwinStaticArchive } from './sdk-darwin-hardening.mjs';

const strip = spawnSync('/opt/homebrew/opt/llvm/bin/llvm-strip', ['--version'], { encoding: 'utf8' }).status === 0 ? '/opt/homebrew/opt/llvm/bin/llvm-strip' : 'llvm-strip';
const available = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'clang'], { encoding: 'utf8' }).status === 0 && spawnSync(strip, ['--version'], { encoding: 'utf8' }).status === 0;
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'apple-static-hardening-'));
  const source = resolve(directory, 'private-producer-source.c'), dependency = resolve(directory, 'prebuilt-private-dependency.c');
  const object = resolve(directory, 'runtime-with-long-member-name.o'), archive = resolve(directory, 'runtime.a');
  writeFileSync(dependency, 'int prebuilt_dependency(void) { return 3; }\n');
  run('xcrun', ['clang', '-g', '-O1', '-c', dependency, '-o', resolve(directory, 'prebuilt.o')]);
  function compile(content = 'extern int host(int); extern int prebuilt_dependency(void); int (*entry_pointer)(int); int runtime_entry(int x) { return host(x) + prebuilt_dependency() + 7; }\n') {
    writeFileSync(source, content);
    run('xcrun', ['clang', '-g', '-O1', '-c', source, '-o', object]);
    rmSync(archive, { force: true });
    run('xcrun', ['ar', 'rcs', archive, object, resolve(directory, 'prebuilt.o')]);
  }
  compile();
  return { directory, archive, compile, remove() { rmSync(directory, { recursive: true, force: true }); } };
}

test('all Apple static members lose DWARF and an independent consumer still links and runs', { skip: !available }, () => {
  const f = fixture(); try {
    const before = readFileSync(f.archive), original = inspectDarwinStaticArchive(before);
    assert.equal(original.length, 2); assert.ok(original.every(member => member.debugSections.length));
    assert.ok(before.includes(Buffer.from(f.directory)));
    const report = hardenDarwinStaticArchive(f.archive, { strip, sourcePrefixes: [f.directory] });
    assert.ok(report.removedDebugSections > 0); assert.equal(report.remainingDebugSections, 0);
    assert.equal(report.remainingDebugSymbols, 0); assert.equal(report.linkableSectionsSymbolsAndRelocationsPreserved, true);
    assert.ok(!readFileSync(f.archive).includes(Buffer.from(f.directory)));
    const consumer = resolve(f.directory, 'consumer.c'), linked = resolve(f.directory, 'consumer');
    writeFileSync(consumer, 'extern int runtime_entry(int); int host(int x) { return x; } int main(void) { return runtime_entry(1) == 11 ? 0 : 1; }\n');
    run('xcrun', ['clang', consumer, f.archive, '-o', linked]); run(linked, []);
  } finally { f.remove(); }
});

test('a no-op Apple strip cannot publish members with DWARF', { skip: !available }, () => {
  const f = fixture(); try {
    const fake = resolve(f.directory, 'no-op-strip');
    writeFileSync(fake, `#!${process.execPath}\nif(process.argv[2]==='--version')console.log('llvm-strip fixture');\n`, { mode: 0o755 });
    assert.throws(() => hardenDarwinStaticArchive(f.archive, { strip: fake }), /retained DWARF\/STABS/);
  } finally { f.remove(); }
});

test('Apple debug removal rejects private paths retained in runtime data', { skip: !available }, () => {
  const f = fixture(); try {
    f.compile('const char private_path[] = "/Users/private-producer/secret.c"; int runtime_entry(void) { return private_path[0]; }\n');
    assert.throws(() => hardenDarwinStaticArchive(f.archive, { strip, sourcePrefixes: ['/Users/private-producer/'] }), /retained a producer source prefix/);
  } finally { f.remove(); }
});

test('an Apple strip tool cannot silently replace linkable runtime bytes', { skip: !available }, () => {
  const f = fixture(); try {
    const original = resolve(f.directory, 'original.a'); copyFileSync(f.archive, original);
    f.compile('extern int host(int); extern int prebuilt_dependency(void); int (*entry_pointer)(int); int runtime_entry(int x) { return host(x) + prebuilt_dependency() + 8; }\n');
    hardenDarwinStaticArchive(f.archive, { strip });
    const changed = resolve(f.directory, 'changed.a'); copyFileSync(f.archive, changed); copyFileSync(original, f.archive);
    const fake = resolve(f.directory, 'false-strip');
    writeFileSync(fake, `#!${process.execPath}\nif(process.argv[2]==='--version')console.log('llvm-strip fixture');else import('node:fs').then(fs=>fs.copyFileSync(${JSON.stringify(changed)},process.argv[3]));\n`, { mode: 0o755 });
    assert.throws(() => hardenDarwinStaticArchive(f.archive, { strip: fake }), /changed linkable sections, symbols or relocations/);
  } finally { f.remove(); }
});

test('malformed, thin, fat and truncated Apple static archives fail closed', () => {
  for (const bytes of [Buffer.from('!<thin>\n'), Buffer.from('!<arch>\n'), Buffer.from('!<arch>\ninvalid'), Buffer.from([0xca, 0xfe, 0xba, 0xbe])]) assert.throws(() => inspectDarwinStaticArchive(bytes));
});
