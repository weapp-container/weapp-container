import { execFileSync } from 'node:child_process'

const EVIDENCE_PATHS = [
  /^docs\/(?:devtools-evidence|engine-evidence|host-evidence|mobile-gpu-evidence|performance-evidence|evidence)\//,
  /^docs\/evidence-ledger\.json$/,
  /^docs\/conformance\/(?:case-index-v1\.(?:json|sha256)|evidence\/.*)$/,
]

// The website is a checked-in submodule with its own build and release
// boundary. It is not an input to any native or runtime artifact receipt.
const REUSABLE_SOURCE_PATHS = new Set(['website'])

export function isEvidenceArchivePath(path) {
  return EVIDENCE_PATHS.some(pattern => pattern.test(path))
}

function isReusableSourcePath(path) {
  return isEvidenceArchivePath(path) || REUSABLE_SOURCE_PATHS.has(path)
}

/**
 * Reports identify the source commit that was measured, which naturally
 * precedes the commit archiving their bytes. Reuse that report only across an
 * ancestor chain containing evidence archives/indexes; any runtime, build,
 * tool, fixture or gate change requires a new run.
 */
export function inspectEvidenceSource(root, sourceCommit, currentCommit) {
  const invalid = typeof sourceCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sourceCommit)
    || typeof currentCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(currentCommit)
  const result = {
    sourceCommit: sourceCommit || null,
    currentCommit: currentCommit || null,
    exact: false,
    compatible: false,
    archiveOnly: false,
    changedPaths: [],
    nonEvidencePaths: [],
    incompatiblePaths: [],
    reason: 'source/current commit is missing or invalid',
  }
  if (invalid) return result
  const git = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  try {
    const source = git(['rev-parse', '--verify', `${sourceCommit}^{commit}`])
    const current = git(['rev-parse', '--verify', `${currentCommit}^{commit}`])
    if (source === current) return {
      ...result, exact: true, compatible: true, reason: 'source commit matches current HEAD',
    }
    git(['merge-base', '--is-ancestor', source, current])
    const changedPaths = git(['diff', '--name-only', '-z', source, current]).split('\0').filter(Boolean)
    const nonEvidencePaths = changedPaths.filter(path => !isEvidenceArchivePath(path))
    const incompatiblePaths = changedPaths.filter(path => !isReusableSourcePath(path))
    const compatible = incompatiblePaths.length === 0
    const archiveOnly = compatible && nonEvidencePaths.length === 0
    return {
      ...result,
      compatible,
      archiveOnly,
      changedPaths,
      nonEvidencePaths,
      incompatiblePaths,
      reason: compatible
        ? archiveOnly
          ? 'source commit is an ancestor of HEAD with only evidence archive/index changes'
          : 'source commit is an ancestor of HEAD with only unrelated website submodule changes'
        : 'source commit differs from HEAD in runtime, build, tool, fixture or gate inputs',
    }
  } catch {
    return { ...result, reason: 'source commit is unavailable or is not an ancestor of current HEAD' }
  }
}
