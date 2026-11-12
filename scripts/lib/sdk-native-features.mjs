// Shared native build plan: selected diagnostic features are release provenance.
import { distributionIdentity } from './showcase-policy.mjs';

export const NATIVE_TARGETS = Object.freeze(Object.fromEntries(Object.entries({
  'aarch64-linux-android': ['android', 'quickjs-native-android', 'skia-gpu-gles'],
  'x86_64-linux-android': ['android', 'quickjs-native-android', 'skia-gpu-gles'],
  'aarch64-apple-ios': ['ios', 'quickjs-native-ios', 'skia-gpu-metal'],
  'aarch64-apple-ios-sim': ['ios', 'quickjs-native-ios', 'skia-gpu-metal'],
  'x86_64-apple-ios': ['ios', 'quickjs-native-ios', 'skia-gpu-metal'],
  'aarch64-apple-darwin': ['macos', 'quickjs-native', 'skia-gpu-metal'],
  'x86_64-apple-darwin': ['macos', 'quickjs-native', 'skia-gpu-metal'],
  'x86_64-pc-windows-msvc': ['windows', 'quickjs-native', 'skia-gpu-gles'],
  'x86_64-unknown-linux-gnu': ['linux', 'quickjs-native', 'skia-gpu-gles'],
}).map(([target, values]) => [target, Object.freeze(values)])));
const diagnosticModes = Object.freeze(['off', 'cpu', 'atrace']);

export function parseNativeBuildArgs(args) {
  const valueOptions = new Set(['--target', '--profile', '--out', '--target-dir', '--view-diagnostics', '--distribution-profile', '--showcase-policy', '--showcase-font', '--showcase-font-license', '--llvm-strip']);
  const booleanOptions = new Set(['--offline', '--help']);
  const options = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!valueOptions.has(key) && !booleanOptions.has(key)) throw Error(`Unknown native build option: ${key}`);
    if (Object.hasOwn(options, key)) throw Error(`Duplicate native build option: ${key}`);
    if (booleanOptions.has(key)) { options[key] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw Error(`${key} requires a value`);
    options[key] = value;
  }
  const mode = options['--view-diagnostics'] ?? 'off';
  if (!diagnosticModes.includes(mode)) throw Error('--view-diagnostics must be off, cpu or atrace');
  const profile = options['--profile'] ?? 'release';
  if (!['release', 'dev'].includes(profile)) throw Error('--profile must be release or dev');
  const distributionProfile = options['--distribution-profile'] ?? 'full';
  if (!['full', 'restricted-showcase'].includes(distributionProfile)) throw Error('--distribution-profile must be full or restricted-showcase');
  if ((distributionProfile === 'restricted-showcase') !== (options['--showcase-policy'] !== undefined)) throw Error('Restricted showcase requires --showcase-policy; full builds must not supply one');
  for (const name of ['--showcase-font', '--showcase-font-license']) if ((distributionProfile === 'restricted-showcase') !== (options[name] !== undefined)) throw Error(`Restricted native producer requires ${name}; full builds must not supply one`);
  if (distributionProfile === 'restricted-showcase' && (profile !== 'release' || mode !== 'off')) throw Error('Restricted showcase requires release profile and diagnostics off');
  return Object.freeze({ ...options, '--view-diagnostics': mode, '--profile': profile });
}

export function nativeBuildPlan(target, viewDiagnostics = 'off', distributionProfile = 'full') {
  const base = NATIVE_TARGETS[target];
  if (!base) throw Error(`Unsupported SDK target: ${target}`);
  if (!diagnosticModes.includes(viewDiagnostics)) throw Error('--view-diagnostics must be off, cpu or atrace');
  if (viewDiagnostics === 'atrace' && base[0] !== 'android') throw Error('atrace View diagnostics require an Android target');
  const features = base.slice(1);
  if (viewDiagnostics !== 'off') features.push('view-batch-diagnostics');
  if (viewDiagnostics === 'atrace') features.push('android-view-atrace');
  if (!['full', 'restricted-showcase'].includes(distributionProfile)) throw Error('Invalid distribution profile');
  if (distributionProfile === 'restricted-showcase') {
    if (viewDiagnostics !== 'off') throw Error('Restricted showcase diagnostics must be off');
    features.push('restricted-showcase');
  }
  return Object.freeze({ platform: base[0], viewDiagnostics, features: Object.freeze(features) });
}

export function assertNativeFeatureIdentity(receipt) {
  if (typeof receipt?.viewDiagnostics !== 'string') throw Error('Native producer diagnostic mode is required');
  const { distributionProfile } = distributionIdentity(receipt);
  const plan = nativeBuildPlan(receipt.target, receipt.viewDiagnostics, distributionProfile);
  if (!Array.isArray(receipt.features) || receipt.features.length !== plan.features.length
    || new Set(receipt.features).size !== receipt.features.length
    || plan.features.some(feature => !receipt.features.includes(feature))) {
    throw Error('Native producer features do not match the selected diagnostic mode and target');
  }
  return plan;
}
