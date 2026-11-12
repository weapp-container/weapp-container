/** Closed static CLI shapes shared by fixture capture and macro admission.
 * This module performs no I/O and grants no output provenance by itself. */
import { isAbsolute, join, resolve } from 'node:path'

export const DIRECT_STATIC_CLI_PROFILE = 'static-direct-root-v1'
export const TEMPLATE_STATIC_CLI_PROFILE = 'static-template-weapp-directory-v1'
export const TEMPLATE_STATIC_CASE = Object.freeze({
  caseId: 'ide-template-weapp-vite-multi-platform-template',
  caseSourcePath: 'e2e/ide/template-weapp-vite-multi-platform-template.test.ts',
  sourceSha256: '5968eea1626e824c54b73555a0d655059e20e2fe87e3fff0908ca9e119da32e7',
  templateRelativePath: 'templates/weapp-vite-multi-platform-template',
})

export const TEMPLATE_SFC_STATIC_CASE = Object.freeze({
  caseId: 'ide-template-weapp-vite-multi-platform-sfc-template',
  caseSourcePath: 'e2e/ide/template-weapp-vite-multi-platform-sfc-template.test.ts',
  sourceSha256: '41dbc3838ad1a3b7ab6d6d7cd03df7690586d2d0623ca84214cbac2fcec51a8b',
  templateRelativePath: 'templates/weapp-vite-multi-platform-sfc-template',
})
export const TEMPLATE_STATIC_CASES = Object.freeze([TEMPLATE_STATIC_CASE, TEMPLATE_SFC_STATIC_CASE])
export const templateStaticCase = identity => identity && TEMPLATE_STATIC_CASES.find(value =>
  ['caseId', 'caseSourcePath', 'sourceSha256'].every(key => identity[key] === value[key])) || null

export function parseStaticCliInvocation({ args, cliPath, cwd, checkout, caseId, caseSourcePath, sourceSha256 }) {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string') || args[0] !== cliPath
    || args[1] !== 'build' || !args[2] || args[2].startsWith('-')) return null
  const sourceRoot = isAbsolute(args[2]) ? resolve(args[2]) : cwd && resolve(cwd, args[2])
  if (!sourceRoot) return null
  if (args.length === 3 || args.length === 5 && args[3] === '--platform' && args[4] === 'weapp')
    return Object.freeze({ profile: DIRECT_STATIC_CLI_PROFILE, sourceRoot })
  const template = templateStaticCase({ caseId, caseSourcePath, sourceSha256 })
  if (args.length !== 6 || args[3] !== '--platform' || args[4] !== 'weapp' || args[5] !== '--skipNpm'
    || !isAbsolute(checkout ?? '') || !template
    || sourceRoot !== join(checkout, template.templateRelativePath) || cwd !== sourceRoot
    || args[2] !== sourceRoot) return null
  return Object.freeze({ profile: TEMPLATE_STATIC_CLI_PROFILE, sourceRoot,
    templateRelativePath: template.templateRelativePath,
    sourceConfigRelative: 'config/weapp/project.config.json', outputContainerRelative: 'dist',
    runtimeProjectRelative: 'dist/weapp', generatedRelative: 'dist/weapp/dist',
    runtimeProjectPath: join(sourceRoot, 'dist/weapp'), generatedRoot: join(sourceRoot, 'dist/weapp/dist') })
}

export function staticFixtureInputClosure(invocation, sourceBefore) {
  return { projectPath: invocation.sourceRoot, sourceBefore,
    ...(invocation.profile === TEMPLATE_STATIC_CLI_PROFILE ? { staticCliProfile: invocation } : {}) }
}
