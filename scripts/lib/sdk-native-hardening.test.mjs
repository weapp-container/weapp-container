import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { hardenLinuxStaticArchive, inspectLinuxStaticArchive } from './sdk-native-hardening.mjs';
import { hardenRetainedNative } from '../sdk-native-harden-retained.mjs';

function tool(name) {
  const explicit = `/opt/homebrew/opt/llvm/bin/${name}`;
  if (existsSync(explicit)) return explicit;
  const result = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? name : undefined;
}
const clang = tool('clang'), ar = tool('llvm-ar'), strip = tool('llvm-strip');
const selectedRustc = spawnSync('rustup', ['which', 'rustc'], { encoding: 'utf8' });
const rustc = selectedRustc.status === 0 ? selectedRustc.stdout.trim() : 'rustc';
const sysroot = spawnSync(rustc, ['--print', 'sysroot'], { encoding: 'utf8' });
const host = spawnSync(rustc, ['-vV'], { encoding: 'utf8' }).stdout?.match(/^host: (.+)$/m)?.[1];
const rustLinker = sysroot.status === 0 && host ? resolve(sysroot.stdout.trim(), 'lib/rustlib', host, 'bin/rust-lld') : undefined;
const linker = tool('ld.lld') ?? (rustLinker && existsSync(rustLinker) ? rustLinker : undefined);
const available = Boolean(clang && ar && strip && linker);
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'native-static-hardening-'));
  const source = resolve(directory, 'private-producer-source.c'), object = resolve(directory, 'runtime.o'), archive = resolve(directory, 'runtime.a');
  function compile(content) {
    writeFileSync(source, content);
    run(clang, ['--target=x86_64-unknown-linux-gnu', '-g', '-O1', '-fPIC', '-c', source, '-o', object]);
    run(ar, ['--format=gnu', 'rcs', archive, object]);
  }
  compile('extern int host(int); int (*entry_pointer)(int); int runtime_entry(int x) { return host(x) + 7; }\n');
  return { directory, source, object, archive, compile, remove() { rmSync(directory, { recursive: true, force: true }); } };
}

test('real ELF static archive drops private DWARF and still links an independent consumer', { skip: !available }, () => {
  const f = fixture(); try {
    const before = readFileSync(f.archive); assert.ok(before.includes(Buffer.from(f.directory)));
    assert.ok(inspectLinuxStaticArchive(before).some(member => member.debugSections.length));
    const report = hardenLinuxStaticArchive(f.archive, { strip, sourcePrefixes: [f.directory] });
    assert.ok(report.removedDebugSections > 0); assert.equal(report.remainingDebugSections, 0);
    assert.equal(report.linkableSectionsSymbolsAndRelocationsPreserved, true);
    assert.ok(!readFileSync(f.archive).includes(Buffer.from(f.directory)));
    const consumer = resolve(f.directory, 'consumer.c'), object = resolve(f.directory, 'consumer.o'), linked = resolve(f.directory, 'linked.o');
    writeFileSync(consumer, 'extern int runtime_entry(int); int host(int x) { return x; } int main(void) { return runtime_entry(1); }\n');
    run(clang, ['--target=x86_64-unknown-linux-gnu', '-c', consumer, '-o', object]);
    run(linker, [...(linker.endsWith('rust-lld') ? ['-flavor', 'gnu'] : []), '-r', object, f.archive, '-o', linked]);
    assert.ok(readFileSync(linked).includes(Buffer.from('runtime_entry\0')));
  } finally { f.remove(); }
});

test('debug removal refuses source paths retained in executable data', { skip: !available }, () => {
  const f = fixture(); try {
    f.compile('const char private_path[] = "/home/runner/private-producer/secret.c"; int runtime_entry(void) { return private_path[0]; }\n');
    assert.throws(() => hardenLinuxStaticArchive(f.archive, { strip, sourcePrefixes: ['/home/runner/'] }), /retained a producer source prefix/);
  } finally { f.remove(); }
});

test('a strip executable cannot silently change linkable runtime bytes', { skip: !available || process.platform === 'win32' }, () => {
  const f = fixture(); try {
    const original = resolve(f.directory, 'original.a'); copyFileSync(f.archive, original);
    f.compile('extern int host(int); int (*entry_pointer)(int); int runtime_entry(int x) { return host(x) + 8; }\n');
    hardenLinuxStaticArchive(f.archive, { strip });
    const changed = resolve(f.directory, 'changed.a'); copyFileSync(f.archive, changed);
    copyFileSync(original, f.archive);
    const fake = resolve(f.directory, 'false-strip');
    writeFileSync(fake, `#!${process.execPath}\nif(process.argv[2]==='--version')console.log('llvm-strip fixture');else import('node:fs').then(fs=>fs.copyFileSync(${JSON.stringify(changed)},process.argv[3]));\n`, { mode: 0o755 });
    assert.throws(() => hardenLinuxStaticArchive(f.archive, { strip: fake }), /changed linkable sections, symbols or relocations/);
  } finally { f.remove(); }
});

test('thin, malformed and path-aliasing retained archive inputs are rejected', () => {
  for (const bytes of [Buffer.from('!<thin>\n'), Buffer.from('!<arch>\n'), Buffer.from('!<arch>\ninvalid')]) assert.throws(() => inspectLinuxStaticArchive(bytes));
  assert.throws(() => hardenRetainedNative({ input: '/tmp/native-original', out: '/tmp/native-original/derived' }), /new independent output/);
});
