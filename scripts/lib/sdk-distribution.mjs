import { distributionIdentity, loadDistributionInput } from './showcase-policy.mjs';
/** Core producers read a policy file; standalone wrappers only consume its identity. */
export function sdkDistribution(values) {
  const distributionProfile = values.get('--distribution-profile') ?? 'full';
  const policy = values.get('--showcase-policy');
  const requestedHash = values.get('--showcase-policy-sha256');
  const identity = policy === undefined
    ? distributionIdentity({ distributionProfile, policySha256: requestedHash })
    : loadDistributionInput({ distributionProfile, showcasePolicy: policy });
  if (requestedHash !== undefined && requestedHash !== identity.policySha256) throw new Error('Selected showcase policy SHA-256 mismatch');
  const expectedDistribution = distributionIdentity(identity);
  const fontArgs = ['--showcase-font', '--showcase-font-license'].flatMap(name => values.has(name) ? [name, values.get(name)] : []);
  const producerArgs = ['--distribution-profile', distributionProfile, ...(policy ? ['--showcase-policy', policy] : []), ...fontArgs];
  const wrapperArgs = ['--distribution-profile', distributionProfile,
    ...(expectedDistribution.policySha256 ? ['--showcase-policy-sha256', expectedDistribution.policySha256] : [])];
  return { expectedDistribution, producerArgs, wrapperArgs, fontArgs };
}
