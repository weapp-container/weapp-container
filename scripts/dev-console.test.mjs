import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../crates/container-core/src/dev-console.js', import.meta.url), 'utf8');
const realm = () => {
  const context = createContext({});
  runInContext(`${source}\nglobalThis.drain = __dev_console;`, context);
  return (script) => runInContext(script, context);
};

test('opt-in console snapshots never invoke accessors or user JSON hooks', () => {
  const run = realm();
  run(`console.log('hidden'); __container_set_dev_console_enabled(true);
    let reads = 0; const value = {get x(){reads++;throw 1}, toJSON(){throw 2}};
    value.self = value; console.log('visible',value);`);
  const result = JSON.parse(run('JSON.stringify(drain())'));
  assert.equal(result.entries.length, 1);
  assert.match(result.entries[0].message, /visible/);
  assert.match(result.entries[0].message, /\[Accessor\]/);
  assert.equal(run('reads'), 0);
});

test('captured primitives and null-prototype queues survive prototype mutation', () => {
  const run = realm();
  run(`__container_set_dev_console_enabled(true);
    Array.prototype.toJSON = function(){throw 1};
    Object.prototype.toJSON = function(){throw 2};
    String.prototype.slice = function(){throw 3};
    Object.create = function(){throw 4};
    Object.defineProperty = function(){throw 5};
    console.warn('still works',{value:7});`);
  const result = JSON.parse(run('JSON.stringify(drain())'));
  assert.equal(result.entries[0].level, 'warn');
  assert.match(result.entries[0].message, /still works/);
  assert.equal(JSON.parse(run('JSON.stringify(drain())')).entries.length, 0);
});

test('diagnostic floods have a fixed entry and character budget with explicit loss', () => {
  const run = realm();
  run(`__container_set_dev_console_enabled(true); for(let i=0;i<10000;i++)console.log('x'.repeat(10000));`);
  const result = JSON.parse(run('JSON.stringify(drain())'));
  assert.ok(result.entries.length <= 128);
  assert.ok(result.entries.every(value => value.message.length <= 2048));
  assert.ok(result.entries.reduce((sum, value) => sum + value.message.length, 0) <= 67584);
  assert.ok(result.dropped > 0);
});

test('proxy formatting cannot recursively bypass the diagnostic budget', () => {
  const run = realm();
  run(`__container_set_dev_console_enabled(true); let count=0;
    const value=new Proxy({}, {ownKeys(){if(count++<500)console.log(value);return []}});
    console.log(value);`);
  const result=JSON.parse(run('JSON.stringify(drain())'));
  assert.equal(result.entries.length,1);
  assert.equal(result.dropped,1);
});
