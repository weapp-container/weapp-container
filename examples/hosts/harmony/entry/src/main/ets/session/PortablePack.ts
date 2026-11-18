/** Platform-free, eagerly verified resource closure for an embedded app. */
export interface ManifestModule { id: string; sha256: string; }
export interface ManifestTemplate { id: string; wxmlAst: string; }
export interface ManifestStyle { id: string; wxssIr: string; scope: string; }
export interface ManifestAsset { path: string; sha256: string; size: number; }
export interface ManifestRoute { path: string; config?: string; }
export interface ManifestComponent { owner: string; usingComponents: Record<string, string>; }
export interface CompiledViewModule { sourceSha256: string; executableSha256: string; }
export interface CompiledViewExpression { executableSha256: string; }
export interface CompiledViewDocument { wxmlAst: string; expressions: Array<CompiledViewExpression>; }
export interface ViewCompilation { modules: Array<CompiledViewModule>; documents: Array<CompiledViewDocument>; }
export interface ManifestIntegrity { algorithm: string; root: string; }
export interface ManifestApp { appJson: string; entryModule: string; }
export interface RendererProfiles { version: string; default: string; pages: Record<string, string>; }
export interface ModernSource { path: string; sha256: string; }
export interface ModernUnit { id: string; executableSha256: string; sourceMapSha256: string; sources: Array<ModernSource>; }
export interface ModernView { compiler: string; version: string; abi: string; target: string; units: Array<ModernUnit>; }
export interface PortableManifest {
  schemaVersion: number;
  protocolVersion?: string;
  app: ManifestApp;
  integrity: ManifestIntegrity;
  routes: Array<ManifestRoute>;
  modules: Array<ManifestModule>;
  templates: Array<ManifestTemplate>;
  styles: Array<ManifestStyle>;
  assets?: Array<ManifestAsset>;
  components?: Array<ManifestComponent>;
  viewScripts?: Array<ManifestModule>;
  viewCompilation?: ViewCompilation;
  rendering?: RendererProfiles;
  modernView?: ModernView;
}

export function digestPointer(pointer: string): string {
  if (typeof pointer !== 'string') throw new Error('ERR_INVALID_MANIFEST: blob reference is not a string');
  const digest = pointer.startsWith('sha256:') ? pointer.substring(7) : pointer;
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`ERR_INVALID_MANIFEST: invalid SHA-256 reference: ${pointer}`);
  return digest;
}

function byteValues(bytes: Uint8Array): Array<number> {
  const result: Array<number> = [];
  for (let index = 0; index < bytes.length; index += 1) result.push(bytes[index]);
  return result;
}

export interface PackModulePayload { id: string; bytes: Array<number>; }

export class PortablePack {
  readonly manifestJson: string;
  readonly manifest: PortableManifest;
  readonly blobs: Record<string, Array<number>>;
  readonly integrityRoot: string;

  private constructor(manifestJson: string, manifest: PortableManifest, blobs: Record<string, Array<number>>) {
    this.manifestJson = manifestJson;
    this.manifest = manifest;
    this.blobs = blobs;
    this.integrityRoot = manifest.integrity.root;
  }

  /** All reads and hashes complete before the native session can be replaced.
   * Rust remains authoritative for schema, canonical manifest integrity and IR.
   * A typed JSON cast here is never treated as native validation.
   */
  static load(read: (path: string) => Uint8Array, decode: (bytes: Uint8Array) => string,
    sha256: (bytes: Uint8Array) => string): PortablePack {
    const manifestJson = decode(read('manifest.json'));
    const manifest = JSON.parse(manifestJson) as PortableManifest;
    if (manifest === null || ![1, 2, 3].includes(manifest.schemaVersion) || manifest.integrity === undefined ||
      manifest.integrity.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(manifest.integrity.root) ||
      !Array.isArray(manifest.routes) || manifest.routes.length === 0 ||
      !Array.isArray(manifest.modules) || manifest.modules.length === 0 ||
      !Array.isArray(manifest.templates) || !Array.isArray(manifest.styles)) {
      throw new Error('ERR_INVALID_MANIFEST: expected schema v1/v2/v3 pack with routes, modules and SHA-256 integrity');
    }
    if ((manifest.schemaVersion === 1 && manifest.modernView !== undefined) ||
      (manifest.schemaVersion === 2 && manifest.modernView === undefined) ||
      ((manifest.schemaVersion === 3) !== (manifest.rendering !== undefined))) {
      throw new Error('ERR_INVALID_MANIFEST: schema, modernView and rendering requirements differ');
    }
    if (manifest.rendering !== undefined) {
      const rendering = manifest.rendering;
      const profiles: Array<string> = ['skia', 'webview', 'skyline-compat'];
      if (rendering === null || rendering.version !== '1.0' || !profiles.includes(rendering.default) ||
        rendering.pages === null || typeof rendering.pages !== 'object' || Array.isArray(rendering.pages) ||
        Object.keys(rendering).some((key: string): boolean => !['version', 'default', 'pages'].includes(key))) {
        throw new Error('ERR_INVALID_MANIFEST: unsupported rendering profile declaration');
      }
      for (const page of Object.keys(rendering.pages)) {
        if (!page || /[\\#?:\x00-\x1f\x7f-\x9f]/.test(page) || /\.(wxml|json)$/.test(page) ||
          page.split('/').some((part: string): boolean => !part || part === '.' || part === '..') ||
          !manifest.routes.some((route: ManifestRoute): boolean => route.path === page) || !profiles.includes(rendering.pages[page])) {
          throw new Error('ERR_INVALID_MANIFEST: invalid rendering page profile');
        }
      }
    }
    const blobs: Record<string, Array<number>> = {};
    const load = (pointer: string): void => {
      const digest = digestPointer(pointer);
      const canonical = `sha256:${digest}`;
      if (blobs[canonical] !== undefined) return;
      const bytes = read(`blobs/sha256/${digest}`);
      if (sha256(bytes) !== digest) throw new Error(`ERR_INVALID_MANIFEST: blob SHA-256 mismatch: ${digest}`);
      blobs[canonical] = byteValues(bytes);
    };
    for (const module of manifest.modules) load(module.sha256);
    for (const template of manifest.templates) load(template.wxmlAst);
    for (const style of manifest.styles) load(style.wxssIr);
    if (manifest.assets !== undefined) {
      for (const asset of manifest.assets) {
        load(asset.sha256);
        if (!Number.isSafeInteger(asset.size) || asset.size < 0 ||
          blobs[`sha256:${digestPointer(asset.sha256)}`].length !== asset.size) {
          throw new Error(`ERR_INVALID_MANIFEST: asset size mismatch: ${asset.path}`);
        }
      }
    }
    if (manifest.viewScripts !== undefined) for (const script of manifest.viewScripts) load(script.sha256);
    if (manifest.viewCompilation !== undefined) {
      for (const module of manifest.viewCompilation.modules) {
        load(module.sourceSha256);
        load(module.executableSha256);
      }
      for (const document of manifest.viewCompilation.documents) {
        load(document.wxmlAst);
        for (const expression of document.expressions) load(expression.executableSha256);
      }
    }
    if (manifest.modernView !== undefined) {
      const modern = manifest.modernView;
      if (modern === null || modern.compiler !== 'weapp-container-modern-view' || modern.version !== '1.0.0' ||
        modern.abi !== '1.0' || modern.target !== 'es2022' || !Array.isArray(modern.units) || modern.units.length === 0) {
        throw new Error('ERR_INVALID_MANIFEST: unsupported modernView compiler');
      }
      const unitIds: Array<string> = [];
      for (const unit of modern.units) {
        if (unit === null || !/^modern:[0-9a-f]{64}$/.test(unit.id) || unitIds.includes(unit.id) ||
          !Array.isArray(unit.sources) || unit.sources.length === 0) throw new Error('ERR_INVALID_MANIFEST: invalid modernView unit');
        unitIds.push(unit.id);
        load(unit.executableSha256);
        load(unit.sourceMapSha256);
        for (const source of unit.sources) {
          if (source === null || typeof source.path !== 'string' || !source.path) throw new Error('ERR_INVALID_MANIFEST: invalid modernView source');
          load(source.sha256);
        }
      }
    }
    return new PortablePack(manifestJson, manifest, blobs);
  }

  firstRoute(): string { return this.manifest.routes[0].path; }

  requireRoute(path: string): string {
    if (!this.manifest.routes.some((route: ManifestRoute) => route.path === path) ||
      !this.manifest.templates.some((template: ManifestTemplate) => template.id === `template:${path}.wxml`)) {
      throw new Error(`ERR_INVALID_MANIFEST: undeclared route or missing route template: ${path}`);
    }
    return path;
  }

  modules(): Array<PackModulePayload> {
    return this.manifest.modules.map((module: ManifestModule): PackModulePayload => {
      return { id: module.id, bytes: this.blobs[`sha256:${digestPointer(module.sha256)}`] };
    });
  }

  /** Preserve manifest cascade order while excluding unrelated page styles. */
  styleIds(path: string): Array<string> {
    this.requireRoute(path);
    const route = this.manifest.routes.find((item: ManifestRoute) => item.path === path);
    if (route === undefined) throw new Error('ERR_INVALID_MANIFEST: route missing');
    const pending: Array<string> = [this.manifest.app.appJson, route.config || `${path}.json`];
    const owners: Array<string> = [];
    const graph = this.manifest.components || [];
    while (pending.length > 0) {
      const owner = pending.pop();
      if (owner === undefined || owners.includes(owner)) continue;
      owners.push(owner);
      const declaration = graph.find((item: ManifestComponent) => item.owner === owner);
      if (declaration === undefined) continue;
      for (const key of Object.keys(declaration.usingComponents)) {
        const target = declaration.usingComponents[key];
        if (typeof target !== 'string' || target.length === 0 || target.startsWith('/') || target.split('/').includes('..')) {
          throw new Error('ERR_INVALID_MANIFEST: component style graph requires normalized relative targets');
        }
        pending.push(`${target}.json`);
      }
    }
    const reachable = owners.map((owner: string): string => `style:${owner.replace(/\.json$/, '.wxss')}`);
    return this.manifest.styles.filter((style: ManifestStyle) => style.scope === 'app' || reachable.includes(style.id))
      .map((style: ManifestStyle) => style.id);
  }
}
