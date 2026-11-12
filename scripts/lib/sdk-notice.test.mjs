import assert from 'node:assert/strict';
import test from 'node:test';
import { posix, win32 } from 'node:path';
import { isNoticeFileName, portableNoticePath } from './sdk-notice.mjs';

test('native producer paths serialize to portable notice identities on POSIX and Windows', () => {
  assert.equal(portableNoticePath('/registry/skia', '/registry/skia/vendor/LICENSE', posix), 'vendor/LICENSE');
  assert.equal(portableNoticePath('C:\\registry\\skia', 'C:\\registry\\skia\\vendor\\LICENSE', win32), 'vendor/LICENSE');
  assert.equal(portableNoticePath('\\\\server\\share\\skia', '\\\\server\\share\\skia\\vendor\\LICENSE', win32), 'vendor/LICENSE');
  for (const [root, file, path] of [
    ['/registry/skia', '/registry/other/LICENSE', posix],
    ['C:\\registry\\skia', 'C:\\registry\\other\\LICENSE', win32],
    ['C:\\registry\\skia', 'D:\\registry\\skia\\LICENSE', win32],
    ['/registry/skia', '/registry/skia/vendor\\LICENSE', posix],
  ]) assert.throws(() => portableNoticePath(root, file, path), /inside its source/);
});

test('keeps complete conventional notices and legal qualifiers', () => {
  for (const name of ['LICENSE', 'LICENCE', 'LICENSE.MIT', 'LICENSE-APACHE', 'LICENSE-APACHE-2.0',
    'NOTICE.txt', 'notice.md', 'COPYING.LIB', 'COPYING.LESSER', 'COPYING.GPL-2.0',
    'COPYRIGHT', 'COPYRIGHT.rst', 'LICENSE.third-party', 'LICENSE-MIT.txt', 'license.html', 'LICENSE.htm']) {
    assert.equal(isNoticeFileName(name), true, name);
  }
});

test('rejects similarly named implementation, compiler and credential files', () => {
  for (const name of ['copying.rs', 'COPYING.RS', 'license.cpp', 'LICENSE.hpp', 'NOTICE.swift',
    'copyright.js', 'license.test.mjs', 'COPYING.kt', 'LICENSE.c', 'NOTICE.a', 'LICENSE.lib',
    'COPYING.dylib', 'NOTICE.jar', 'LICENSE.key', 'LICENSE.pem', 'LICENSE.json', 'NOTICE.toml',
    'license.tsx', 'copyright.wasm', 'LICENSE.pyc']) {
    assert.equal(isNoticeFileName(name), false, name);
  }
});

test('accepts only a complete basename with a notice prefix', () => {
  for (const name of ['', 'copying', '../LICENSE', 'dir/LICENSE', 'dir\\LICENSE', 'LICENSE\n',
    'my-LICENSE', 'LICENSEManager', 'NOTICEBOARD', 'COPYRIGHTED', 'LICENSE.', 'LICENSE-', null]) {
    assert.equal(isNoticeFileName(name), name === 'copying', String(name));
  }
});
