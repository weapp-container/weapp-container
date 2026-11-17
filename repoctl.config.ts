import type { MonorepoConfig } from 'repoctl'

export default {
  commands: { create: { defaultTemplate: 'tsdown', renameJson: false } },
  tooling: {
    eslint: { stylistic: false, ignores: ['**/fixtures/**', '**/test/fixture/**'] },
    vitest: { includeWorkspaceRootConfig: false, coverageSkipFull: true },
    vitestProject: { globals: false, testTimeout: 60_000 },
  },
} satisfies MonorepoConfig
