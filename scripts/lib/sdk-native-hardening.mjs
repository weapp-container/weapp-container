// Cargo's strip profile does not remove DWARF from every staticlib member.
// Keep the linkable runtime, symbols and relocations while removing debug data.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const debugName = name => /^(?:\.debug|\.zdebug|\.gnu_debug)/.test(name);
function bounded(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) throw Error('Invalid bounded ELF/archive range');
  return bytes.subarray(offset, offset + length);
}
function integer(value) { const number = Number(value); if (!Number.isSafeInteger(number)) throw Error('ELF integer exceeds its bound'); return number; }
function cstring(bytes, offset) {
  if (offset < 0 || offset >= bytes.length) throw Error('Invalid ELF string offset');
  const end = bytes.indexOf(0, offset); if (end < 0) throw Error('Unterminated ELF string');
  return bytes.subarray(offset, end).toString('utf8');
}
function elfSnapshot(bytes) {
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes[4] !== 2 || bytes[5] !== 1) throw Error('Expected ELF64 little-endian static runtime member');
  const start = integer(bytes.readBigUInt64LE(40)), stride = bytes.readUInt16LE(58), count = bytes.readUInt16LE(60), namesIndex = bytes.readUInt16LE(62);
  if (stride !== 64 || count < 1 || count > 65534 || namesIndex >= count) throw Error('Unsupported ELF section table');
  bounded(bytes, start, stride * count);
  const sections = Array.from({ length: count }, (_, index) => {
    const at = start + stride * index;
    return { nameOffset: bytes.readUInt32LE(at), type: bytes.readUInt32LE(at + 4), flags: bytes.readBigUInt64LE(at + 8),
      offset: integer(bytes.readBigUInt64LE(at + 24)), size: integer(bytes.readBigUInt64LE(at + 32)), link: bytes.readUInt32LE(at + 40), info: bytes.readUInt32LE(at + 44), entrySize: integer(bytes.readBigUInt64LE(at + 56)) };
  });
  const names = bounded(bytes, sections[namesIndex].offset, sections[namesIndex].size);
  for (const section of sections) section.name = cstring(names, section.nameOffset);
  const symbols = new Map();
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]; if (section.type !== 2) continue;
    if (section.entrySize !== 24 || section.size % 24 || section.link >= count) throw Error('Invalid ELF static symbol table');
    const content = bounded(bytes, section.offset, section.size), stringsSection = sections[section.link], strings = bounded(bytes, stringsSection.offset, stringsSection.size);
    const entries = [];
    for (let at = 0; at < content.length; at += 24) {
      const target = content.readUInt16LE(at + 6);
      entries.push({ name: cstring(strings, content.readUInt32LE(at)), info: content[at + 4], other: content[at + 5],
        section: target < count ? sections[target].name : `reserved:${target}`, value: content.readBigUInt64LE(at + 8).toString(), size: content.readBigUInt64LE(at + 16).toString() });
    }
    symbols.set(index, entries);
  }
  const allocated = sections.filter(section => section.flags & 2n).map(section => ({ name: section.name, type: section.type, flags: section.flags.toString(), size: section.size,
    sha256: section.type === 8 ? null : sha(bounded(bytes, section.offset, section.size)) }));
  const exported = [...symbols.values()].flat().filter(symbol => [1, 2].includes(symbol.info >> 4)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const relocations = [];
  for (const section of sections) {
    if (![4, 9].includes(section.type)) continue;
    if (section.info >= count || debugName(sections[section.info].name)) continue;
    const entries = symbols.get(section.link), stride = section.type === 4 ? 24 : 16;
    if (!entries || section.entrySize !== stride || section.size % stride) throw Error('Invalid ELF relocation section');
    const content = bounded(bytes, section.offset, section.size);
    for (let at = 0; at < content.length; at += stride) {
      const info = content.readBigUInt64LE(at + 8), symbol = entries[integer(info >> 32n)];
      if (!symbol) throw Error('ELF relocation references a missing symbol');
      relocations.push({ section: sections[section.info].name, offset: content.readBigUInt64LE(at).toString(), type: Number(info & 0xffffffffn), symbol,
        ...(section.type === 4 ? { addend: content.readBigInt64LE(at + 16).toString() } : {}) });
    }
  }
  return { debugSections: sections.filter(section => debugName(section.name)).map(section => section.name),
    runtime: { allocated, exported, relocations } };
}

export function inspectLinuxStaticArchive(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n'))) throw Error('Expected ordinary static archive; thin archives are forbidden');
  const members = []; let position = 8, longNames;
  while (position < bytes.length) {
    const header = bounded(bytes, position, 60); if (header.subarray(58).toString() !== '`\n') throw Error('Invalid static archive member header');
    const sizeText = header.subarray(48, 58).toString().trim(); if (!/^\d+$/.test(sizeText)) throw Error('Invalid archive member size');
    const size = Number(sizeText); let content = bounded(bytes, position + 60, size), name = header.subarray(0, 16).toString().trim();
    if (name === '//') longNames = content;
    else if (name !== '/' && name !== '/SYM64/') {
      if (name.startsWith('#1/')) { const length = Number(name.slice(3)); name = bounded(content, 0, length).toString().replace(/\0+$/, ''); content = bounded(content, length, content.length - length); }
      else if (/^\/\d+$/.test(name)) {
        if (!longNames) throw Error('Missing archive filename table');
        const offset = Number(name.slice(1)), end = longNames.indexOf(Buffer.from('/\n'), offset);
        if (end < offset) throw Error('Invalid archive long filename'); name = bounded(longNames, offset, end - offset).toString();
      } else name = name.replace(/\/$/, '');
      if (!name || /[\0\r\n]/.test(name)) throw Error('Invalid archive member name');
      members.push({ name, ...elfSnapshot(content) });
    }
    position += 60 + size + size % 2;
  }
  if (position !== bytes.length || !members.length || members.length > 100000) throw Error('Invalid or empty bounded static archive');
  return members;
}

export function hardenLinuxStaticArchive(path, { strip = 'strip', sourcePrefixes = [] } = {}) {
  const before = readFileSync(path), original = inspectLinuxStaticArchive(before);
  const version = spawnSync(strip, ['--version'], { encoding: 'utf8', maxBuffer: 65536 });
  if (version.error || version.status !== 0 || !/(?:GNU strip|llvm-strip|LLVM)/i.test(version.stdout + version.stderr)) throw Error('A working GNU/LLVM strip tool is required for Linux release archives');
  const result = spawnSync(strip, ['--strip-debug', path], { encoding: 'utf8', maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw Error('Linux archive debug stripping failed');
  const after = readFileSync(path), hardened = inspectLinuxStaticArchive(after);
  if (hardened.some(member => member.debugSections.length)) throw Error('Linux static archive retained DWARF after stripping');
  const runtime = members => members.map(({ name, runtime }) => ({ name, runtime }));
  if (JSON.stringify(runtime(original)) !== JSON.stringify(runtime(hardened))) throw Error('Linux debug stripping changed linkable sections, symbols or relocations');
  for (const prefix of [...new Set(sourcePrefixes)]) if (typeof prefix === 'string' && prefix.length >= 4 && after.includes(Buffer.from(prefix))) throw Error('Linux static archive retained a producer source prefix');
  return { schemaVersion: 1, operation: 'strip-debug-static-archive', tool: { name: strip.split(/[\\/]/).at(-1), version: (version.stdout || version.stderr).trim().slice(0, 4096) },
    input: { bytes: before.length, sha256: sha(before) }, output: { bytes: after.length, sha256: sha(after) },
    members: hardened.length, removedDebugSections: original.reduce((count, member) => count + member.debugSections.length, 0),
    remainingDebugSections: 0, linkableSectionsSymbolsAndRelocationsPreserved: true, producerSourcePrefixMatches: 0 };
}
