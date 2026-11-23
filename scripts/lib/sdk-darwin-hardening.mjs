// Cargo does not strip debug data from all C/C++ and Rust staticlib members.
// Apple stripping must preserve the object-level linker contract, including
// local relocation targets whose numeric section/symbol indexes can change.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function bounded(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) throw Error('Invalid bounded Mach-O/archive range');
  return bytes.subarray(offset, offset + length);
}
function integer(value) { const n = Number(value); if (!Number.isSafeInteger(n)) throw Error('Mach-O integer exceeds its bound'); return n; }
function fixedName(bytes) { return bytes.toString('utf8').replace(/\0.*$/s, ''); }
function cstring(bytes, offset) {
  if (offset < 0 || offset >= bytes.length) throw Error('Invalid Mach-O string offset');
  const end = bytes.indexOf(0, offset); if (end < 0) throw Error('Unterminated Mach-O string');
  return bytes.subarray(offset, end).toString('utf8');
}
function objectSnapshot(bytes) {
  bounded(bytes, 0, 32);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(12) !== 1) throw Error('Expected Mach-O64 little-endian relocatable static member');
  const cpu = bytes.readUInt32LE(4), count = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20);
  if (![0x01000007, 0x0100000c].includes(cpu) || count > 100000) throw Error('Unsupported Apple static member architecture');
  bounded(bytes, 32, commandBytes);
  const sections = [], commands = []; let symbolsCommand, at = 32;
  for (let index = 0; index < count; index++) {
    const command = bounded(bytes, at, 8), kind = command.readUInt32LE(0), size = command.readUInt32LE(4);
    if (size < 8 || size % 4 || at + size > 32 + commandBytes) throw Error('Invalid Mach-O load command');
    const content = bounded(bytes, at, size);
    if (kind === 0x19) {
      if (size < 72) throw Error('Invalid Mach-O segment command');
      const sectionCount = content.readUInt32LE(64);
      if (size !== 72 + sectionCount * 80) throw Error('Invalid Mach-O section table');
      for (let n = 0; n < sectionCount; n++) {
        const s = bounded(content, 72 + n * 80, 80);
        const name = fixedName(s.subarray(0, 16)), segment = fixedName(s.subarray(16, 32)), flags = s.readUInt32LE(64);
        const address = s.readBigUInt64LE(32), length = integer(s.readBigUInt64LE(40)), offset = s.readUInt32LE(48);
        // Clang also marks the linker's compact-unwind input S_ATTR_DEBUG;
        // it remains required runtime metadata and must survive the comparison.
        const debug = segment === '__DWARF' || Boolean(flags & 0x02000000) && !(segment === '__LD' && name === '__compact_unwind');
        const zeroFill = [1, 0x0c, 0x12].includes(flags & 0xff);
        sections.push({ name: `${segment}/${name}`, address, size: length, align: s.readUInt32LE(52), flags,
          reserved: [s.readUInt32LE(68), s.readUInt32LE(72), s.readUInt32LE(76)], debug,
          sha256: zeroFill ? null : sha(bounded(bytes, offset, length)),
          relocationOffset: s.readUInt32LE(56), relocationCount: s.readUInt32LE(60) });
      }
    } else if (kind === 2) {
      if (size !== 24 || symbolsCommand) throw Error('Invalid Mach-O symbol table command');
      symbolsCommand = content;
    } else if (kind === 0xb) {
      if (size !== 80 || [32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76].some(offset => content.readUInt32LE(offset))) throw Error('Unsupported Mach-O dynamic symbol or relocation table');
    } else if ([0x26, 0x29, 0x2e].includes(kind)) {
      if (size !== 16) throw Error('Invalid Mach-O linkedit data command');
      commands.push({ kind, sha256: sha(bounded(bytes, content.readUInt32LE(8), content.readUInt32LE(12))) });
    } else {
      commands.push({ kind, sha256: sha(content) });
    }
    at += size;
  }
  if (at !== 32 + commandBytes) throw Error('Invalid bounded Mach-O object');
  // Debug-only archive members become valid empty objects after debug removal.
  const symbolBytes = symbolsCommand ? bounded(bytes, symbolsCommand.readUInt32LE(8), symbolsCommand.readUInt32LE(12) * 16) : Buffer.alloc(0);
  const strings = symbolsCommand ? bounded(bytes, symbolsCommand.readUInt32LE(16), symbolsCommand.readUInt32LE(20)) : Buffer.alloc(0);
  const symbols = [];
  for (let p = 0; p < symbolBytes.length; p += 16) {
    const type = symbolBytes[p + 4], sectionIndex = symbolBytes[p + 5], value = symbolBytes.readBigUInt64LE(p + 8);
    if (sectionIndex > sections.length) throw Error('Mach-O symbol references an invalid section');
    const section = sectionIndex ? sections[sectionIndex - 1] : undefined;
    const semantic = { name: cstring(strings, symbolBytes.readUInt32LE(p)), type, description: symbolBytes.readUInt16LE(p + 6),
      section: section?.name ?? null, value: (type & 0x0e) === 0x0e && section ? (value - section.address).toString() :
        (type & 0x0e) === 0x0a ? cstring(strings, integer(value)) : value.toString() };
    symbols.push({ semantic, debug: Boolean(type & 0xe0) || Boolean(section?.debug) });
  }
  const runtimeSections = [];
  for (const section of sections.filter(section => !section.debug)) {
    const relocations = [], content = bounded(bytes, section.relocationOffset, section.relocationCount * 8);
    for (let p = 0; p < content.length; p += 8) {
      const address = content.readUInt32LE(p), info = content.readUInt32LE(p + 4), symbolIndex = info & 0xffffff;
      if (address & 0x80000000) throw Error('Unsupported scattered Mach-O64 relocation');
      const external = Boolean(info & 0x08000000), kind = info >>> 28;
      let target;
      if (external) {
        if (!symbols[symbolIndex] || symbols[symbolIndex].debug) throw Error('Mach-O runtime relocation references missing/debug symbol');
        target = symbols[symbolIndex].semantic;
      } else if (cpu === 0x0100000c && kind === 10) target = { addend: symbolIndex };
      else {
        if (symbolIndex > sections.length || symbolIndex && sections[symbolIndex - 1].debug) throw Error('Mach-O runtime relocation references missing/debug section');
        target = { section: symbolIndex ? sections[symbolIndex - 1].name : 'absolute' };
      }
      relocations.push({ address, kind, external, pcRelative: Boolean(info & 0x01000000), length: (info >>> 25) & 3, target });
    }
    runtimeSections.push({ name: section.name, size: section.size, align: section.align, flags: section.flags,
      reserved: section.reserved, sha256: section.sha256, relocations });
  }
  return { debugSections: sections.filter(section => section.debug).map(section => section.name), debugSymbols: symbols.filter(symbol => symbol.debug).length,
    runtime: { cpu, cpuSubtype: bytes.readUInt32LE(8), flags: bytes.readUInt32LE(24), commands, sections: runtimeSections,
      symbols: symbols.filter(symbol => !symbol.debug).map(symbol => symbol.semantic).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } };
}

export function inspectDarwinStaticArchive(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n'))) throw Error('Expected ordinary Apple static archive; thin/fat archives are forbidden');
  const members = []; let position = 8;
  while (position < bytes.length) {
    const header = bounded(bytes, position, 60); if (header.subarray(58).toString() !== '`\n') throw Error('Invalid Apple archive member header');
    const sizeText = header.subarray(48, 58).toString().trim(); if (!/^\d+$/.test(sizeText)) throw Error('Invalid Apple archive member size');
    const size = Number(sizeText); let content = bounded(bytes, position + 60, size), name = header.subarray(0, 16).toString().trim();
    if (name.startsWith('#1/')) {
      const length = Number(name.slice(3)); name = bounded(content, 0, length).toString().replace(/\0+$/, ''); content = bounded(content, length, content.length - length);
    } else name = name.replace(/\/$/, '');
    if (!name || /[\0\r\n]/.test(name)) throw Error('Invalid Apple archive member name');
    if (!['__.SYMDEF', '__.SYMDEF SORTED', '__.SYMDEF_64', '__.SYMDEF_64 SORTED', '/'].includes(name)) {
      try { members.push({ name, ...objectSnapshot(content) }); }
      catch (error) { throw Error(`Invalid Apple archive member ${name}: ${error.message}`); }
    }
    position += 60 + size + size % 2;
  }
  if (position !== bytes.length || !members.length || members.length > 100000) throw Error('Invalid or empty bounded Apple archive');
  return members;
}

export function hardenDarwinStaticArchive(path, { strip = 'llvm-strip', sourcePrefixes = [] } = {}) {
  const before = readFileSync(path), original = inspectDarwinStaticArchive(before);
  const version = spawnSync(strip, ['--version'], { encoding: 'utf8', maxBuffer: 65536 });
  if (version.error || version.status !== 0 || !/llvm-strip|LLVM version/i.test(version.stdout + version.stderr)) throw Error('A working LLVM strip tool is required for restricted Apple release archives');
  // Apple cctools strip rewrites local relocations and linker-version commands.
  // LLVM removes debug data while preserving the exact linkable object contract.
  const result = spawnSync(strip, ['--strip-debug', path], { encoding: 'utf8', maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw Error(`Apple archive debug stripping failed: ${result.error?.message || result.stderr}`);
  const after = readFileSync(path), hardened = inspectDarwinStaticArchive(after);
  if (hardened.some(member => member.debugSections.length || member.debugSymbols)) throw Error('Apple static archive retained DWARF/STABS after stripping');
  const runtime = members => members.map(({ name, runtime }) => ({ name, runtime }));
  if (JSON.stringify(runtime(original)) !== JSON.stringify(runtime(hardened))) throw Error('Apple debug stripping changed linkable sections, symbols or relocations');
  for (const prefix of [...new Set(sourcePrefixes)]) if (typeof prefix === 'string' && prefix.length >= 4 && after.includes(Buffer.from(prefix))) throw Error('Apple static archive retained a producer source prefix');
  return { schemaVersion: 1, operation: 'strip-debug-apple-static-archive', tool: { name: strip.split(/[\\/]/).at(-1), version: (version.stdout || version.stderr || '').trim().slice(0, 4096) },
    input: { bytes: before.length, sha256: sha(before) }, output: { bytes: after.length, sha256: sha(after) }, members: hardened.length,
    removedDebugSections: original.reduce((count, member) => count + member.debugSections.length, 0), remainingDebugSections: 0, remainingDebugSymbols: 0,
    linkableSectionsSymbolsAndRelocationsPreserved: true, producerSourcePrefixMatches: 0 };
}
