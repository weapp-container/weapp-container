import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'

export const DEVTOOLS_COMPATIBILITY = Object.freeze({
  schemaVersion: 1,
  projectType: 'weapp-vite-miniprogram',
  compiler: Object.freeze({
    name: 'weapp-vite',
    version: '7.5.0',
    commit: '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e',
  }),
  nodeVersion: '24.22.2',
  packageManager: 'pnpm@12.11.2',
  supportedProjects: Object.freeze([
    'examples/apps/community/miniprogram-demo-text',
    'examples/apps/community/ant-design-button',
    'examples/apps/community/taro-blended',
    'examples/apps/shop-demo',
  ]),
  requiredFiles: Object.freeze(['project.config.json', 'app.json']),
})

const exists = async path => access(path, constants.R_OK).then(() => true).catch(() => false)

async function readJson(path, label) {
  let bytes
  try {
    bytes = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`${label} 不可读：${error.message}`)
  }
  try {
    return JSON.parse(bytes)
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`)
  }
}

async function projectRootFromConfig(project, config) {
  const configured = config.srcMiniprogramRoot || config.miniprogramRoot || '.'
  const value = typeof configured === 'string' && configured.trim() ? configured.trim() : '.'
  const root = resolve(project, value)
  if (root !== project && !root.startsWith(`${project}${sep}`)) {
    throw new Error('project.config.json 的小程序源目录不能越过项目目录')
  }
  const canonicalRoot = await realpath(root).catch(error => { throw new Error(`小程序源目录不可用：${error.message}`) })
  if (canonicalRoot !== project && !canonicalRoot.startsWith(`${project}${sep}`)) {
    throw new Error('小程序源目录不能通过符号链接越过项目目录')
  }
  return canonicalRoot
}

function dependencyNames(packageJson) {
  return Object.keys({
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
    ...packageJson?.optionalDependencies,
  }).sort()
}

function missingDependencies(project, packageJson) {
  const require = createRequire(join(project, 'package.json'))
  return dependencyNames(packageJson).filter(name => {
    try {
      require.resolve(name, { paths: [project] })
      return false
    } catch {
      return true
    }
  })
}

export async function inspectProject(value, { metadata = {}, requireDependencies = false } = {}) {
  if (metadata.weappViteCommit && metadata.weappViteCommit !== DEVTOOLS_COMPATIBILITY.compiler.commit) {
    throw new Error('此 DevTools 的编译器来源与兼容矩阵不一致，请重新安装官方发行包')
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error('请选择小程序项目目录')
  const project = await realpath(value.trim())
  const projectStat = await stat(project).catch(error => { throw new Error(`项目路径不可用：${error.message}`) })
  if (!projectStat.isDirectory()) throw new Error('项目路径不是目录')

  const configPath = join(project, 'project.config.json')
  const config = await readJson(configPath, 'project.config.json')
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('project.config.json 必须是对象')
  if (config.compileType !== 'miniprogram') {
    throw new Error(`当前只支持 compileType=miniprogram，实际为 ${config.compileType}`)
  }

  const sourceRoot = await projectRootFromConfig(project, config)
  const appPath = join(sourceRoot, 'app.json')
  if (!(await exists(appPath))) throw new Error(`小程序入口不存在：${relative(project, appPath)}`)
  const app = await readJson(appPath, 'app.json')
  if (!app || typeof app !== 'object' || Array.isArray(app)) throw new Error('app.json 必须是对象')
  if (!Array.isArray(app.pages) || app.pages.length === 0 || app.pages.some(page => typeof page !== 'string' || !page.trim())) {
    throw new Error('app.json 必须声明至少一个有效 pages 路由')
  }
  if (config.miniprogramRoot && typeof config.miniprogramRoot !== 'string') {
    throw new Error('project.config.json 的 miniprogramRoot 必须是相对路径')
  }
  if (config.miniprogramRoot) {
    const outputRoot = resolve(project, config.miniprogramRoot)
    if (outputRoot !== project && !outputRoot.startsWith(`${project}${sep}`)) {
      throw new Error('project.config.json 的 miniprogramRoot 不能越过项目目录')
    }
  }

  const packagePath = join(project, 'package.json')
  const packageJson = await exists(packagePath) ? await readJson(packagePath, 'package.json') : null
  const missing = missingDependencies(project, packageJson)
  const dependenciesInstalled = missing.length === 0
  const expectedCompiler = metadata.weappViteCommit || DEVTOOLS_COMPATIBILITY.compiler.commit
  const compatibility = {
    projectType: DEVTOOLS_COMPATIBILITY.projectType,
    compiler: { expected: expectedCompiler, version: DEVTOOLS_COMPATIBILITY.compiler.version },
    nodeVersion: metadata.nodeVersion || DEVTOOLS_COMPATIBILITY.nodeVersion,
    packageManager: metadata.packageManager || DEVTOOLS_COMPATIBILITY.packageManager,
    dependencies: dependenciesInstalled ? 'ready' : 'missing',
    missingDependencies: missing,
  }
  if (requireDependencies && !dependenciesInstalled) {
    throw new Error('项目依赖尚未安装，请在项目目录执行随包提供的 pnpm install 后重试')
  }
  return {
    project,
    configPath,
    sourceRoot,
    appPath,
    packagePath: packageJson ? packagePath : null,
    packageName: packageJson?.name || null,
    dependenciesInstalled,
    compatibility,
  }
}

export function compatibilityMetadata() {
  return JSON.parse(JSON.stringify(DEVTOOLS_COMPATIBILITY))
}
