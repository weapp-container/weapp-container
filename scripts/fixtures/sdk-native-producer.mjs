// Inert bytes and the real producer receipt shape; never native execution evidence.
import { createHash } from 'node:crypto';
import { SDK_RELEASE_VERSION } from '../lib/sdk-current-release.mjs';

export function nativeProducerFixture(target = 'aarch64-apple-darwin', { version = SDK_RELEASE_VERSION, sourceCommit = '1'.repeat(40), files = { 'libweapp_container_sdk.a': Buffer.from('inert native fixture only\n') } } = {}) {
  const platform = target.includes('android') ? 'android' : target.includes('ios') ? 'ios' : target.includes('darwin') ? 'macos' : target.includes('windows') ? 'windows' : 'linux';
  const features = [platform === 'android' || platform === 'ios' ? `quickjs-native-${platform}` : 'quickjs-native', platform === 'ios' || platform === 'macos' ? 'skia-gpu-metal' : 'skia-gpu-gles'];
  return {
    schemaVersion: 1, sdkVersion: version, abiVersion: 1, sourceCommit, sourceDirty: false,
    target, platform, viewDiagnostics: 'off', profile: 'release', features, toolchain: { rustc: 'fixture compiler; not executed', cargo: 'fixture compiler; not executed' },
    startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:00:01.000Z', status: 'built', exitCode: 0,
    artifacts: Object.entries(files).map(([file, value]) => { const bytes = Buffer.from(value); return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }),
    thirdPartyInputs: [],
  };
}
