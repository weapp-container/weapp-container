import assert from 'node:assert/strict';

export const RELEASE_REPOSITORY = 'weapp-container/weapp-container';
export const RELEASE_SDKS = ['contract', 'android', 'ios', 'desktop'];
export const REQUIRED_WORKFLOWS = ['public-ci.yml', 'documentation.yml', 'publication-security.yml'];
export const RELEASE_ARTIFACTS = [
  ['runtime', 'android', 'arm64-v8a'], ['runtime', 'android', 'x86_64'],
  ['runtime', 'ios', 'arm64-device'], ['runtime', 'ios', 'arm64-simulator'], ['runtime', 'ios', 'x86_64-simulator'],
  ['runtime', 'macos', 'arm64'], ['runtime', 'macos', 'x86_64'],
  ['runtime', 'linux', 'x86_64'], ['runtime', 'windows', 'x86_64'],
  ['android-sdk', 'android', 'universal'], ['ios-sdk', 'ios', 'universal'],
  ['desktop-sdk', 'macos', 'universal'], ['desktop-sdk', 'linux', 'x86_64'], ['desktop-sdk', 'windows', 'x86_64'],
];
const version = /^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*$/;
const commit = /^[a-f0-9]{40}$/;

export function assertCompleteRelease(manifest) {
  assert.equal(manifest.artifacts.length, RELEASE_ARTIFACTS.length, 'A release requires nine runtimes and five SDK archives');
  const identities = manifest.artifacts.map(item => [item.component, item.platform, item.arch].join('/'));
  assert.deepEqual(identities.slice().sort(), RELEASE_ARTIFACTS.map(item => item.join('/')).sort(), 'Release target inventory differs');
  assert.equal(new Set(manifest.artifacts.map(item => item.fileName)).size, 14, 'Release filenames must be distinct');
  for (const artifact of manifest.artifacts) if (artifact.arch === 'universal') {
    const expected = artifact.platform === 'android' ? ['arm64-v8a', 'x86_64']
      : artifact.platform === 'ios' ? ['arm64-device', 'arm64-simulator', 'x86_64-simulator'] : ['arm64', 'x86_64'];
    assert.deepEqual(artifact.architectures?.slice().sort(), expected.slice().sort(), 'Universal archive slices differ');
  }
}

export function assertProductionRun(run) {
  assert.equal(run.repository?.full_name, RELEASE_REPOSITORY, 'Production must belong to the core repository');
  assert.equal(run.head_repository?.full_name, RELEASE_REPOSITORY, 'Fork production is forbidden');
  assert.equal(run.head_branch, 'main', 'Production must use main');
  assert.equal(run.event, 'workflow_dispatch', 'Production must be manually dispatched');
  assert.equal(run.path, '.github/workflows/public-native.yml', 'Unexpected production workflow');
  assert.equal(run.status, 'completed', 'Production has not completed');
  assert.equal(run.conclusion, 'success', 'Production did not succeed');
  assert.match(run.head_sha, commit);
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  return run;
}

export function assertCandidate(candidate, policy, pins) {
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.repository, RELEASE_REPOSITORY);
  assert.equal(candidate.prepareRelease, true, 'Production did not request release preparation');
  assert.match(candidate.runtimeVersion, version, 'Only explicit prerelease versions are accepted');
  assert.match(candidate.publishedRuntimeVersion, version);
  assert.equal(candidate.runtimeVersion, policy.runtimeVersion);
  assert.equal(candidate.publishedRuntimeVersion, policy.publishedRuntimeVersion);
  assert.equal(candidate.abiVersion, policy.abiVersion);
  assert.match(candidate.sourceCommit, commit);
  assert.match(candidate.runtimeRunId, /^[1-9]\d*$/);
  assert.deepEqual(Object.keys(candidate.sdks).sort(), RELEASE_SDKS.slice().sort());
  for (const sdk of RELEASE_SDKS) {
    assert.equal(candidate.sdks[sdk].repository, `weapp-container/sdk-${sdk}`);
    assert.match(candidate.sdks[sdk].commit, commit);
    assert.equal(candidate.sdks[sdk].version, sdk === 'contract' ? policy.contractVersion : policy.runtimeVersion, `${sdk} version is not coordinated`);
    if (pins) assert.equal(candidate.sdks[sdk].commit, pins[sdk], `${sdk} differs from the production gitlink`);
  }
  return candidate;
}

export function workflowChecks(runs, sha) {
  return REQUIRED_WORKFLOWS.map(file => {
    const eligible = runs.filter(run => run.head_sha === sha && run.path === `.github/workflows/${file}`
      && run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event)
      && run.repository?.full_name === RELEASE_REPOSITORY && run.head_repository?.full_name === RELEASE_REPOSITORY);
    return eligible.sort((a, b) => b.id - a.id || (b.run_attempt ?? 1) - (a.run_attempt ?? 1))[0];
  });
}

export function checksReady(runs, sha) {
  return workflowChecks(runs, sha).every(run => run?.status === 'completed' && run.conclusion === 'success');
}

export function assertWrapperReceipt(receipt, sdk, candidate, targets) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.sdkVersion, candidate.runtimeVersion);
  assert.equal(receipt.sourceCommit, candidate.sdks[sdk].commit, 'Wrapper must use the production-pinned SDK commit');
  assert.equal(receipt.sourceDirty, false);
  assert.equal(receipt.status, { android: 'passed', ios: 'built', desktop: 'verified' }[sdk]);
  assert.ok(!receipt.error, 'Wrapper retains a failure');
  for (const check of receipt.checks ?? []) if (typeof check === 'object' && check !== null) {
    assert.ok(!check.error && !['failed', 'blocked'].includes(check.status) && check.result !== 'failed'
      && (check.exitCode === undefined || check.exitCode === 0), 'Wrapper consumer check failed');
  }
  assert.deepEqual(receipt.native.map(item => item.target).sort(), targets.slice().sort());
  for (const native of receipt.native) {
    assert.equal(native.sourceCommit, candidate.sourceCommit, 'Wrapper runtime must come from the selected production');
    assert.equal(native.sdkVersion, candidate.runtimeVersion);
    assert.equal(native.sourceDirty, false);
    assert.equal(native.distributionProfile, 'full');
  }
}

export function releaseNotes(candidate, changelog) {
  return `# Weapp Container ${candidate.runtimeVersion}\n\nPublic preview, C ABI ${candidate.abiVersion}.\n\n${changelog}\n\n`
    + `## Build and verification\n\nCore source: [${candidate.sourceCommit}](https://github.com/${RELEASE_REPOSITORY}/commit/${candidate.sourceCommit}).\n`
    + `Production: https://github.com/${RELEASE_REPOSITORY}/actions/runs/${candidate.runtimeRunId}.\n\n`
    + RELEASE_SDKS.map(sdk => `- ${sdk}: [${candidate.sdks[sdk].commit}](https://github.com/${candidate.sdks[sdk].repository}/commit/${candidate.sdks[sdk].commit})`).join('\n')
    + '\n\nNine runtime archives: Android arm64-v8a/x86_64; iOS arm64 device and arm64/x86_64 simulator; macOS arm64/x86_64; Linux/Windows x86_64. Five wrapper archives: Android universal, iOS universal, and macOS/Linux/Windows Desktop.\n\n'
    + 'All 14 archives passed hashes, license collection, fresh offline installation, cache revalidation and incorrect-hash rejection. Android passed independent AAR/R8 consumer compilation and 16KB alignment checks. iOS passed staged SwiftPM compilation and Pod lint. Desktop passed installed consumers on macOS, Linux and Windows.\n\n'
    + '## Limitations\n\nThese checks do not establish physical-device or hardware-GPU execution, full WeChat compatibility, or completion of npm, Maven Central, CocoaPods Trunk or pub.dev publication. Review the attached manifest, provenance and SHA256SUMS before publishing this prerelease.\n';
}
