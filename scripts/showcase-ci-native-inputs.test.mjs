import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reviewedNativeInput } from './showcase-ci-native-inputs.mjs';
const lock = JSON.parse(readFileSync(new URL('./fixtures/showcase-ci-native-inputs.lock.json', import.meta.url)));
test('reuse selects only the reviewed exact successful native producer within its original Actions artifact', () => {
  const input = reviewedNativeInput(lock, 'windows-98d7e613', 'windows', 'x86_64-pc-windows-msvc');
  assert.equal(input.sourceCommit, '98d7e6139a684270a615d1571de078287fa087ba');
  assert.throws(() => reviewedNativeInput(lock, 'unreviewed', 'windows', input.target));
  assert.throws(() => reviewedNativeInput(lock, 'windows-98d7e613', 'linux', 'x86_64-unknown-linux-gnu'));
  for (const patch of [{ distributionProfile: 'full' }, { sha256: 'bad' }, { sourceCommit: null }, { artifactId: 0 }, { artifactName: 'other-artifact' }]) {
    const changed = structuredClone(lock); Object.assign(changed.inputs['windows-98d7e613'], patch);
    assert.throws(() => reviewedNativeInput(changed, 'windows-98d7e613', 'windows', input.target));
  }
  assert.throws(() => reviewedNativeInput({ ...lock, repository: 'unrelated/repository' }, 'windows-98d7e613', 'windows', input.target));
});
