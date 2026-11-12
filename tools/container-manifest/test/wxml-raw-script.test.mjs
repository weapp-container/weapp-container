import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { parseWxml } from '../src/index.mjs';

test('WXS raw text shares a lossless source/AST contract with the Rust parser', async () => {
  const contract = JSON.parse(await fs.readFile(new URL('./fixtures/wxml-wxs-raw-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseWxml(contract.source), contract.ast);
  const [script, following] = parseWxml(contract.source).nodes[0].children;
  assert.equal(script.children.length, 1);
  assert.deepEqual(script.children[0].bindings, []);
  assert.deepEqual(following.children[0].bindings, ['script.label']);
});

test('WXS empty, whitespace-only and external bodies retain their boundaries', () => {
  const [empty, whitespace, external, following] = parseWxml(
    '<wxs module="empty"></wxs><wxs module="space"> \r\n\t</wxs \t><wxs module="external" src="./helper.wxs"/><text>{{value}}</text>',
  ).nodes;
  assert.deepEqual(empty.children, []);
  assert.deepEqual(whitespace.children, [{ kind: 'text', value: ' \r\n\t', bindings: [] }]);
  assert.deepEqual(external.children, []);
  assert.equal(external.attrs.src, './helper.wxs');
  assert.deepEqual(following.children[0].bindings, ['value']);
});

test('WXS requires its own complete closing tag', () => {
  for (const source of [
    '<wxs module="x">a < b',
    '<wxs module="x">"</view>"</wxs-extra>',
    '<wxs module="x">"</wxs invalid>"',
    '<wxs module="x">source</wxs',
  ]) {
    assert.throws(() => parseWxml(source), /unexpected end of input while parsing WXML raw text element/);
  }
});
