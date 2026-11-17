// Renderer requirements are separate from executable View language profiles.
// The source compiler's app/page JSON bytes are retained unchanged in the pack.
export const RENDERING_MANIFEST_SCHEMA_VERSION = 3;
export const RENDERING_PROFILE_VERSION = '1.0';
const profiles = new Set(['skia', 'webview', 'skyline-compat']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalRoute = value => typeof value === 'string' && value.length > 0
  && !/[\\#?:\x00-\x1f\x7f-\x9f]/.test(value) && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..')
  && !/\.(?:wxml|json)$/.test(value);

function invalid(message, file) {
  const error = new Error(message);
  error.code = 'ERR_RENDERER_CONFIG';
  error.path = file;
  throw error;
}

function originalProfile(config, file) {
  const value = config?.renderer;
  if (value === undefined) return undefined;
  if (value === 'webview') return 'webview';
  if (value === 'skyline') return 'skyline-compat';
  invalid(`Unsupported source renderer ${JSON.stringify(value)}; expected webview or skyline`, file);
}

/** Precedence: configured page > source page > configured default > source app > skia. */
export function buildRendererProfiles(routes, app, sourceConfigs, sourceConfig) {
  let configured;
  if (sourceConfig) {
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceConfig.bytes));
    configured = config.renderer;
  }
  const configFile = sourceConfig?.configPath ?? 'container.config.json';
  if (configured !== undefined && (!record(configured)
    || Object.keys(configured).some(key => !['default', 'pages'].includes(key)))) {
    invalid('renderer must be an object containing default and/or pages', configFile);
  }
  if (configured?.default !== undefined && !profiles.has(configured.default)) {
    invalid('renderer.default must be skia, webview or skyline-compat', configFile);
  }
  if (configured?.pages !== undefined && !record(configured.pages)) {
    invalid('renderer.pages must be an object keyed by emitted route path', configFile);
  }
  const declaredRoutes = new Set(routes.map(route => route.path));
  for (const [page, profile] of Object.entries(configured?.pages ?? {})) {
    if (!canonicalRoute(page) || !declaredRoutes.has(page)) {
      invalid(`renderer.pages key is not a declared emitted route: ${page}`, configFile);
    }
    if (!profiles.has(profile)) {
      invalid(`Unsupported renderer profile for ${page}: ${JSON.stringify(profile)}`, configFile);
    }
  }
  const appProfile = originalProfile(app, 'app.json');
  const pageProfiles = new Map(routes.map(route => [route.path,
    originalProfile(sourceConfigs.get(route.config ?? `${route.path}.json`), route.config ?? `${route.path}.json`)]));
  if (configured === undefined && appProfile === undefined
    && ![...pageProfiles.values()].some(profile => profile !== undefined)) return undefined;
  const defaultProfile = configured?.default ?? appProfile ?? 'skia';
  const pageOverrides = configured?.pages ?? {};
  return {
    version: RENDERING_PROFILE_VERSION,
    default: defaultProfile,
    pages: Object.fromEntries([...routes].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      .map(route => [route.path, Object.hasOwn(pageOverrides, route.path)
        ? pageOverrides[route.path] : pageProfiles.get(route.path) ?? defaultProfile])),
  };
}
