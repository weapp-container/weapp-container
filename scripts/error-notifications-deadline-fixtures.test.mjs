import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// Finite probes verify which production entry reaches each infinite native
// deadline attack. They do not claim native interruption coverage themselves.
const nativeSource = readFileSync(new URL('../crates/container-engine-quickjs/tests/appservice_deadline.rs', import.meta.url), 'utf8')
const fixtures = new Map([...nativeSource.matchAll(/^        "(error-message|error-stack|error-coercion|error-handler)" => "([^"\n]*)",$/gm)]
  .map(([, name, source]) => [name, source]))
assert.equal(fixtures.size, 4, 'read every production native error deadline fixture')

function fixture(engine) {
  const realm = createAppServiceTestRealm(engine)
  return { ...realm, batch: realm.transports.batchCall }
}

for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: ordinary engine exceptions skip accessors and coercion`, () => {
    const r = fixture(engine)
    for (const expression of [
      "({ get message() { attackCount++; return 'message'; } })",
      "({ message: 'failed', get stack() { attackCount++; return 'stack'; } })",
      "({ message: { toString() { attackCount++; return 'message'; } } })",
    ]) {
      const original = r.run(`globalThis.attackCount = 0; globalThis.original = ${expression};
        globalThis.fail = function() { throw original; }; original`)
      let thrown
      try { r.batch(null, 'fail', []) } catch (error) { thrown = error }
      assert.equal(thrown, original)
      assert.equal(r.run('attackCount'), 0)
    }
  })

  test(`${engine}: public handler aliases cannot create engine exception listeners`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace = []; globalThis.fail = function() { throw Error('failed'); };
      globalThis.__container_error_handlers = [function() { trace.push('public'); }];`)
    assert.throws(() => r.batch(null, 'fail', []), /failed/)
    assert.deepEqual(r.json('trace'), [])
    r.run(`wx.onError(function(value) { trace.push('private:' + value); });
      globalThis.__container_error_handlers = [function() { trace.push('forged'); }];`)
    assert.throws(() => r.batch(null, 'fail', []), /failed/)
    assert.deepEqual(r.json('trace'), ['private:failed'])
  })

  for (const [name, source] of fixtures) {
    test(`${engine}: native ${name} attack reaches a supported production entry`, () => {
      const r = fixture(engine)
      assert.equal(source.split('while (true) {}').length, 2, 'retain one infinite attack')
      const probe = source.replace('while (true) {}', "globalThis.attackCount += 1; return 'finite attack';")
      r.run(`globalThis.attackCount = 0; globalThis.exports = {}; ${probe}
        globalThis.run = exports.run;`)
      let thrown, result
      try { result = r.batch(null, 'run', []) } catch (error) { thrown = error }
      assert.equal(r.run('attackCount'), name === 'error-stack' ? 2 : 1)
      if (name === 'error-handler') assert.match(thrown?.message, /failed/)
      else { assert.equal(thrown, undefined); assert.equal(result, 'null') }
    })
  }
}
