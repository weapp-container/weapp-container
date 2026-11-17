#!/usr/bin/env python3
"""Bounded AAR/APK byte, ELF64 and notice validation. Executes no archive code."""
import hashlib
import json
from pathlib import Path
import re
import stat
import struct
import sys
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def elf(data, library, machine):
    require(len(data) >= 64 and data[:6] == bytes([127, 69, 76, 70, 2, 1]), 'Not little-endian ELF64')
    require(struct.unpack_from('<H', data, 18)[0] == machine, 'Wrong native architecture')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    require(56 <= size <= 1024 and 0 < count <= 1024 and offset + size * count <= len(data), 'Invalid ELF program table')
    loads, dynamic = [], None
    for index in range(count):
        kind, flags, file_offset, address, physical, file_size, memory_size, alignment = struct.unpack_from('<IIQQQQQQ', data, offset + index * size)
        require(file_offset + file_size <= len(data), 'ELF segment escapes file')
        if kind == 1:
            require(alignment >= 16384 and file_offset % 16384 == address % 16384, 'Native ELF is not 16 KB compatible')
            loads.append((file_offset, address, file_size, alignment))
        if kind == 2:
            require(dynamic is None and file_size % 16 == 0, 'Invalid ELF dynamic segment')
            dynamic = (file_offset, file_size)
    require(loads and dynamic, 'ELF load/dynamic segments missing')
    values = {}
    for at in range(dynamic[0], sum(dynamic), 16):
        kind, value = struct.unpack_from('<qQ', data, at)
        if kind == 0:
            break
        values.setdefault(kind, []).append(value)
    require(len(values.get(5, [])) == 1 and len(values.get(10, [])) == 1 and len(values.get(14, [])) == 1, 'ELF string/SONAME table missing')
    address, length = values[5][0], values[10][0]
    matches = [file_offset + address - virtual for file_offset, virtual, file_size, _ in loads if virtual <= address and address + length <= virtual + file_size]
    require(len(matches) == 1 and 0 < length <= 16 * 1024 * 1024, 'Invalid ELF dynamic strings')
    strings = data[matches[0]:matches[0] + length]

    def name(at):
        require(at < len(strings), 'ELF dynamic string escapes table')
        end = strings.find(b'\0', at)
        require(at < end <= at + 4096, 'Invalid ELF dynamic name')
        value = strings[at:end].decode('ascii')
        require('/' not in value and '\\' not in value and not re.search(r'[\x00-\x20\x7f]', value), 'Nonportable ELF dynamic name')
        return value

    soname = name(values[14][0])
    require(soname == library, 'ELF SONAME differs from packaged library')
    return {'machine': machine, 'loadAlignments': [value[3] for value in loads], 'soname': soname, 'needed': [name(value) for value in values.get(1, [])]}


def inspect(options):
    path = Path(options['archive'])
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 512 * 1024 ** 2, 'Archive must be a bounded ordinary file')
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    prefix = 'jni/' if options['kind'] == 'aar' else 'lib/'
    expected = {prefix + item['abi'] + '/' + item['library']: item for item in options.get('binaries', [])}
    require(len(expected) == len(options.get('binaries', [])), 'Duplicate expected native identity')
    expected_files = {item['path']: item for item in options.get('files', [])}
    require(len(expected_files) == len(options.get('files', [])), 'Duplicate expected package file')
    files, binaries, seen, total = [], [], set(), 0
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            directory = item.is_dir()
            name = item.filename[:-1] if directory else item.filename
            require(name and not name.startswith('/') and not re.search(r'[\\:\x00-\x20\x7f]', name)
                    and all(part not in ('', '.', '..') for part in name.split('/')) and name not in seen, 'Unsafe/duplicate ZIP member')
            seen.add(name)
            total += item.file_size
            require(len(seen) <= 100000 and total <= 1024 ** 3 and item.file_size <= 256 * 1024 ** 2, 'ZIP expansion limit')
            require(not stat.S_ISLNK(item.external_attr >> 16), 'ZIP links are forbidden')
            if directory:
                require(item.file_size == 0, 'ZIP directory contains bytes')
                continue
            require(not re.search(r'[.](rs|cpp|cc|c|h|hpp)$', name, re.I), 'Private native source in package')
            data = archive.read(item)
            record = {'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            files.append(record)
            if name in expected_files:
                require(record == expected_files[name], 'APK changed a pinned notice or fixture file: ' + name)
            if name.endswith('.so'):
                require(name in expected, 'Unexpected packaged native library: ' + name)
                bound = expected[name]
                require(record['sha256'] == bound['sha256'] and (bound.get('bytes') is None or len(data) == bound['bytes']), 'Package changed original AAR/native bytes: ' + name)
                native = elf(data, bound['library'], 183 if bound['abi'] == 'arm64-v8a' else 62)
                if bound.get('needed') is not None:
                    require(native['needed'] == bound['needed'] and native['soname'] == bound['soname'], 'Native dynamic dependencies changed')
                binaries.append({**bound, **native, 'bytes': len(data), 'sha256': record['sha256']})
    actual = {item['path']: item for item in files}
    require(set(expected).issubset(actual) and set(expected_files).issubset(actual), 'Missing pinned native/notice/fixture files')
    require('AndroidManifest.xml' in actual, 'Android manifest missing')
    if options['kind'] != 'aar':
        require(actual.get('classes.dex', {}).get('size', 0) > 0, 'Compiled APK dex missing')
    else:
        require(actual.get('classes.jar', {}).get('size', 0) > 0, 'Compiled AAR classes missing')
    require(hashlib.sha256(path.read_bytes()).hexdigest() == before, 'Archive changed during inspection')
    return {'path': str(path), 'size': path.stat().st_size, 'sha256': before,
            'binaries': sorted(binaries, key=lambda item: (item['abi'], item['library'])), 'files': sorted(files, key=lambda item: item['path'])}


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(json.loads(Path(sys.argv[1]).read_text()))))
    except Exception as error:
        print('ERR_ANDROID_CONSUMER_PACKAGE: ' + str(error), file=sys.stderr)
        sys.exit(1)
