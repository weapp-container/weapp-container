import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packContainer } from '@sonofmagic/container-manifest';

const marker = '.weapp-container-test-artifact';
async function generation() {
  const root = await mkdtemp(join(tmpdir(), 'weapp-container-test-'));
  await writeFile(join(root, marker), '1\n');
  return root;
}

/** Snapshot compiled output before packing; published generations never mutate. */
export async function packArtifact(artifact, options = {}) {
  const root = await generation();
  try {
    let input = artifact.miniprogramRootPath;
    if (!input) {
      const project = resolve(artifact.projectPath);
      let config = {};
      try { config = JSON.parse(await readFile(join(project, 'project.config.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      input = resolve(project, config.miniprogramRoot ?? '.');
    }
    const sourceRoot = join(root, 'source');
    await cp(input, sourceRoot, { recursive: true, dereference: true });
    const packPath = join(root, 'pack');
    await packContainer(sourceRoot, packPath, { platform: 'weapp', project: artifact.projectPath, resolveRoot: artifact.projectPath, ...options });
    return { packPath, sourceRoot, generationRoot: root };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function componentArtifact(artifact, componentPath, options = {}) {
  if (typeof componentPath !== 'string' || !componentPath.trim() || componentPath.split('/').includes('..')) throw new TypeError('component path must be project-relative');
  const root = await generation();
  try {
    const sourceRoot = join(root, 'source');
    await cp(artifact.sourceRoot, sourceRoot, { recursive: true, dereference: true });
    const route = '__container_test__/index';
    const host = join(sourceRoot, '__container_test__');
    await mkdir(host, { recursive: true });
    const app = JSON.parse(await readFile(join(sourceRoot, 'app.json'), 'utf8'));
    app.pages = [...new Set([...(app.pages ?? []), route])];
    await writeFile(join(sourceRoot, 'app.json'), JSON.stringify(app));
    const properties = options.properties ?? {};
    for (const name of Object.keys(properties)) if (!/^[A-Za-z_][\w-]*$/.test(name)) throw new TypeError(`Invalid component property: ${name}`);
    const attributes = Object.keys(properties).map(name => `${name}="{{__properties.${name}}}"`).join(' ');
    const events = options.events ?? [];
    for (const name of events) if (!/^[A-Za-z_][\w-]*$/.test(name)) throw new TypeError(`Invalid component event: ${name}`);
    const bindings = events.map((name, index) => `bind:${name}="__event${index}"`).join(' ');
    const methods = events.map((name, index) => `__event${index}(event){const next=this.data.__emitted.slice();next.push({name:${JSON.stringify(name)},detail:event.detail});this.setData({__emitted:next});}`).join(',');
    const slots = Object.entries(options.slots ?? {}).map(([name, markup]) => {
      if (name === 'default') return markup;
      if (!/^[A-Za-z_][\w-]*$/.test(name)) throw new TypeError(`Invalid slot: ${name}`);
      return `<view slot="${name}">${markup}</view>`;
    }).join('');
    await Promise.all([
      writeFile(join(host, 'index.json'), JSON.stringify({ usingComponents: { subject: '/' + componentPath.replace(/^\/+/, '').replace(/\.(js|json|wxml)$/, '') } })),
      writeFile(join(host, 'index.js'), `Page({data:{__properties:${JSON.stringify(properties)},__emitted:[]},__setProperties(value){this.setData({__properties:{...this.data.__properties,...value}})},${methods}});`),
      writeFile(join(host, 'index.wxml'), `<subject id="subject" ${attributes} ${bindings}>${slots}</subject>`),
    ]);
    const packPath = join(root, 'pack');
    await packContainer(sourceRoot, packPath, { platform: 'weapp' });
    return { packPath, sourceRoot, generationRoot: root };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

/** Call only after every container using the generation has closed. */
export async function disposeArtifact(artifact) {
  if (!artifact.generationRoot) return;
  const root = resolve(artifact.generationRoot);
  if (artifact.packPath !== join(root, 'pack') || artifact.sourceRoot !== join(root, 'source')
      || await readFile(join(root, marker), 'utf8') !== '1\n') throw new Error('Refusing to remove an unowned artifact generation');
  await rm(root, { recursive: true });
}

/** Optional compiler adapter; the runtime SDK itself has no compiler dependency. */
export async function buildWeappViteArtifact(options = {}) {
  const { buildTestArtifact } = await import('weapp-vite/test');
  return packArtifact(await buildTestArtifact({ ...options, platform: 'weapp' }));
}

export async function watchWeappViteArtifact({ onRebuilt, onError, ...options } = {}) {
  const { watchTestArtifact } = await import('weapp-vite/test');
  let closed = false;
  const generations = new Set();
  let pending = Promise.resolve();
  let watcher;
  const pack = async artifact => {
    const result = await packArtifact(artifact);
    generations.add(result);
    return result;
  };
  try {
    watcher = await watchTestArtifact({ ...options, platform: 'weapp',
      onError(error) { if (!closed) onError?.(error); },
      onRebuilt(artifact) {
        const update = pending.then(async () => {
          if (closed) return;
          const result = await pack(artifact);
          if (!closed) await onRebuilt?.(result);
        });
        pending = update.catch(error => { if (!closed) onError?.(error); });
        return pending;
      },
    });
    const artifact = await pack(watcher.artifact);
    return { artifact, generations,
      async close() {
        closed = true;
        const results = await Promise.allSettled([watcher.close(), pending]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Compiler watcher cleanup failed');
      },
    };
  } catch (error) {
    closed = true;
    const results = await Promise.allSettled([watcher?.close(), pending]);
    const cleanup = results.filter(result => result.status === 'rejected').map(result => result.reason);
    for (const artifact of generations) { try { await disposeArtifact(artifact); } catch (failure) { cleanup.push(failure); } }
    if (cleanup.length) throw new AggregateError([error, ...cleanup], 'Compiler startup and cleanup failed');
    throw error;
  }
}
