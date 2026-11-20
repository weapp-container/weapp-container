import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function inspectInstalledHarmonyNapiTypes(project) {
  const packagePath = join(project, 'entry/oh_modules/libentry.so')
  const declarationPath = join(packagePath, 'index.d.ts')
  if (!existsSync(packagePath) || !existsSync(declarationPath)) throw new Error('ohpm did not install the local libentry.so type package')
  const resolvedProject = realpathSync(project)
  const resolvedPackage = realpathSync(packagePath)
  const packageRelative = relative(resolvedProject, resolvedPackage)
  if (isAbsolute(packageRelative) || packageRelative === '..' || packageRelative.startsWith(`..${sep}`)) {
    throw new Error('local libentry.so package resolves outside the isolated Harmony project')
  }
  const resolvedDeclaration = realpathSync(declarationPath)
  const declarationRelative = relative(resolvedPackage, resolvedDeclaration)
  if (isAbsolute(declarationRelative) || declarationRelative === '..' || declarationRelative.startsWith(`..${sep}`)) {
    throw new Error('local libentry.so declarations resolve outside the installed package')
  }
  return { path: 'entry/oh_modules/libentry.so', resolvedPath: packageRelative, typesSha256: sha(readFileSync(resolvedDeclaration)) }
}
