import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {makeFixture} from '../../shared/make-fixture.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
export function makeHostFixture(repository, destination) {
  makeFixture(repository, destination);
  const manifest = JSON.parse(readFileSync(resolve(destination, 'manifest.json')));
  const blob = value => { const bytes = typeof value === 'string' ? value : canonical(value); const hash = sha(bytes); writeFileSync(resolve(destination, 'blobs/sha256', hash), bytes); return hash; };
  for (const module of manifest.modules.filter(value => /^module:pages\/(home|detail)\/index\.js$/.test(value.id))) {
    const original = readFileSync(resolve(destination, 'blobs/sha256', module.sha256), 'utf8');
    module.sha256 = blob(original.replace(' onTap() {', " onTouch(event) { weappContainer.postMessage({kind:'touch',type:event.type,touches:event.touches.length,changed:event.changedTouches.length}); },\n onTap() {"));
  }
  for (const template of manifest.templates.filter(value => /^template:pages\/(home|detail)\/index\.wxml$/.test(value.id))) {
    const original = JSON.parse(readFileSync(resolve(destination, 'blobs/sha256', template.wxmlAst.slice(7))));
    for (const event of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      original.nodes[0].attrs[`bind${event}`] = 'onTouch';
      original.nodes[0].directives.events[`bind${event}`] = 'onTouch';
    }
    template.wxmlAst = `sha256:${blob(original)}`;
    const document = manifest.viewCompilation?.documents.find(value => value.documentId === template.id.slice(9));
    if (document) document.wxmlAst = template.wxmlAst;
  }
  manifest.integrity.root = ''; manifest.integrity.root = sha(canonical(manifest));
  writeFileSync(resolve(destination, 'manifest.json'), canonical(manifest));
  return manifest.integrity.root;
}
