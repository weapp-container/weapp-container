import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseWxss, canonicalize, WXSS_IR_VERSION } from '../src/index.ts';

const cases = JSON.parse(await readFile(new URL('fixtures/wxss-v2.json', import.meta.url), 'utf8'));
for (const fixture of cases) {
  test(`WXSS v2: ${fixture.name}`, () => {
    assert.equal(WXSS_IR_VERSION, 2);
    assert.equal(canonicalize(parseWxss(fixture.source)), canonicalize(fixture.ir));
  });
}

test('WXSS imports require a statement and a nonempty prelude', () => {
  for (const source of ['@import;', '@import "a.wxss" {}', '@import "a.wxss" { .a { color:red } }']) {
    assert.throws(() => parseWxss(source), /import/i, source);
  }
  assert.throws(() => parseWxss('color: red;'), /statement/);
});
