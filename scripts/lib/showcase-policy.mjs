import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const requireValue = (value, message) => { if (!value) throw Error(message); };

export function normalizeShowcasePolicy(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'allowedApis,allowedPackRoots,schemaVersion'
    && value.schemaVersion === 1, 'Showcase policy requires schemaVersion 1, allowedPackRoots and allowedApis only');
  const list = (field, valid) => {
    const items = value[field];
    requireValue(Array.isArray(items) && items.length > 0 && items.length <= 1024
      && items.every(valid) && new Set(items).size === items.length, `Invalid, empty or duplicate showcase policy ${field}`);
    return Object.freeze([...items].sort());
  };
  // Property order is canonical UTF-8 order, matching serde_json's map.
  return Object.freeze({ allowedApis: list('allowedApis', item => typeof item === 'string'
      && /^[A-Za-z0-9._:$-]{1,128}$/.test(item)),
    allowedPackRoots: list('allowedPackRoots', digest), schemaVersion: 1 });
}

export function loadDistributionInput({ distributionProfile = 'full', showcasePolicy, profile = 'release', viewDiagnostics = 'off' } = {}) {
  requireValue(['full', 'restricted-showcase'].includes(distributionProfile), 'Distribution profile must be full or restricted-showcase');
  if (distributionProfile === 'full') {
    requireValue(showcasePolicy === undefined, '--showcase-policy requires --distribution-profile restricted-showcase');
    return Object.freeze({ distributionProfile, policySha256: null, policy: null, policyInput: null });
  }
  requireValue(profile === 'release' && viewDiagnostics === 'off', 'Restricted showcase producers require release profile and diagnostics off');
  requireValue(typeof showcasePolicy === 'string' && showcasePolicy.length > 0, 'Restricted showcase requires --showcase-policy');
  const sourcePath = resolve(showcasePolicy), bytes = readFileSync(sourcePath);
  requireValue(bytes.length <= 64 * 1024, 'Showcase policy exceeds 64 KiB');
  const policy = normalizeShowcasePolicy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const canonical = JSON.stringify(policy), policySha256 = sha(canonical);
  return Object.freeze({ distributionProfile, policySha256, policy, canonical,
    policyInput: Object.freeze({ sourcePath, inputSha256: sha(bytes) }) });
}

export function verifyDistributionInput(input) {
  if (input.distributionProfile === 'full') return;
  const current = loadDistributionInput({ distributionProfile: input.distributionProfile, showcasePolicy: input.policyInput.sourcePath });
  requireValue(current.policySha256 === input.policySha256 && current.policyInput.inputSha256 === input.policyInput.inputSha256,
    'Showcase policy changed during compilation');
}

export function distributionIdentity(value = {}) {
  const distributionProfile = value.distributionProfile ?? 'full', policySha256 = value.policySha256 ?? null;
  requireValue(['full', 'restricted-showcase'].includes(distributionProfile)
    && (distributionProfile === 'full' ? policySha256 === null : digest(policySha256)), 'Invalid distribution profile or policy SHA-256');
  return { distributionProfile, policySha256 };
}

export function assertDistributionIdentity(actual, expected = { distributionProfile: 'full', policySha256: null }) {
  const left = distributionIdentity(actual), right = distributionIdentity(expected);
  requireValue(left.distributionProfile === right.distributionProfile && left.policySha256 === right.policySha256,
    'Distribution profile or showcase policy SHA-256 mismatch');
  return left;
}

export function verifyDistributionArtifact(bytes, identity) {
  const { distributionProfile, policySha256 } = distributionIdentity(identity);
  const marker = Buffer.from(`weapp-container-distribution:${distributionProfile}:${policySha256 ?? ''}\0`);
  requireValue(Buffer.from(bytes).includes(marker), 'Compiled artifact is missing the exact distribution policy identity');
  return { distributionProfile, policySha256, markerVerified: true };
}
