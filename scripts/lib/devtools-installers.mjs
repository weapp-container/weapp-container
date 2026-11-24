import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const MSI_UPGRADE_CODE = '{82C5B778-BA8A-4A35-85D6-5D376851F105}'
const LINUX_DEPENDENCIES = [
  'libc6 (>= 2.35)',
  'libgcc-s1',
  'libstdc++6',
  'libgl1',
  'libx11-6',
  'libxkbcommon0',
  'libfontconfig1',
  'xdg-utils',
  'zenity',
]

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 ** 2,
  }).trim()
}

function runInstallerTool(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 ** 2,
    }).trim()
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout)
    if (error.stderr) process.stderr.write(error.stderr)
    throw error
  }
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) throw new Error(`Unsupported DevTools release version ${version}`)
  return match.slice(1, 4).map(Number)
}

export function msiProductVersion(version) {
  const parts = versionParts(version)
  const preview = /-preview\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  const previewBuild = preview ? Number(preview[1]) * 100 + Number(preview[2]) : 999
  const patch = parts[2] * 1000 + previewBuild
  if (parts.slice(0, 2).some(part => part > 255) || patch > 65535 || (preview && (Number(preview[1]) > 9 || Number(preview[2]) > 99))) {
    throw new Error(`Release version ${version} exceeds Windows Installer version limits`)
  }
  return [parts[0], parts[1], patch].join('.')
}

export function msiProductCode(version) {
  msiProductVersion(version)
  const bytes = createHash('sha256').update(`weapp-container-devtools:${version}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex').toUpperCase()
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`
}

export function debianPackageVersion(version) {
  versionParts(version)
  return version.replace(/-preview(?=\.|$)/, '~preview')
}

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

export function renderMsiSource(version) {
  const productVersion = msiProductVersion(version)
  const productCode = msiProductCode(version)
  return `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="${productCode}" Name="Weapp Container DevTools" Language="1033" Version="${productVersion}" Manufacturer="Weapp Container" UpgradeCode="${MSI_UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" Description="Weapp Container DevTools ${xml(version)}" />
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version of Weapp Container DevTools is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="INSTALLFOLDER" Name="Weapp Container DevTools" />
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ApplicationProgramsFolder" Name="Weapp Container DevTools" />
      </Directory>
    </Directory>
    <Feature Id="MainFeature" Title="Weapp Container DevTools" Level="1">
      <ComponentGroupRef Id="DevToolsFiles" />
      <ComponentRef Id="ApplicationShortcut" />
    </Feature>
    <DirectoryRef Id="ApplicationProgramsFolder">
      <Component Id="ApplicationShortcut" Guid="*">
        <Shortcut Id="ApplicationStartMenuShortcut" Name="Weapp Container DevTools" Target="[INSTALLFOLDER]bin\\weapp-devtools.vbs" WorkingDirectory="INSTALLFOLDER" />
        <RemoveFolder Id="ApplicationProgramsFolder" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\\WeappContainer\\DevTools" Name="installed" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>
  </Product>
</Wix>
`
}

export function renderDebControl(version) {
  return [
    'Package: weapp-container-devtools',
    `Version: ${debianPackageVersion(version)}`,
    'Section: devel',
    'Priority: optional',
    'Architecture: amd64',
    `Depends: ${LINUX_DEPENDENCIES.join(', ')}`,
    'Maintainer: Weapp Container <noreply@github.com>',
    'Description: Weapp Container desktop development tools',
    ' Includes the simulator, pinned weapp-vite compiler, Node.js, and renderer resources.',
    '',
  ].join('\n')
}

export async function buildDebRoot(source, packageRoot, version, iconPath) {
  await rm(packageRoot, { recursive: true, force: true })
  const appRoot = join(packageRoot, 'opt/weapp-container-devtools')
  const debianRoot = join(packageRoot, 'DEBIAN')
  const binRoot = join(packageRoot, 'usr/bin')
  const desktopRoot = join(packageRoot, 'usr/share/applications')
  const iconRoot = join(packageRoot, 'usr/share/icons/hicolor/128x128/apps')
  const docsRoot = join(packageRoot, 'usr/share/doc/weapp-container-devtools')
  await Promise.all([appRoot, debianRoot, binRoot, desktopRoot, iconRoot, docsRoot].map(path => mkdir(path, { recursive: true })))
  await cp(source, appRoot, { recursive: true, dereference: true })
  await cp(iconPath, join(iconRoot, 'weapp-container-devtools.png'))
  await cp(join(source, 'LICENSE'), join(docsRoot, 'copyright'))
  await cp(join(source, 'README.md'), join(docsRoot, 'README.md'))
  await writeFile(join(debianRoot, 'control'), renderDebControl(version))
  await writeFile(join(binRoot, 'weapp-devtools'), '#!/bin/sh\nset -eu\nexec /opt/weapp-container-devtools/bin/weapp-devtools "$@"\n', { mode: 0o755 })
  await writeFile(join(desktopRoot, 'weapp-container-devtools.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Weapp Container DevTools',
    'Exec=weapp-devtools gui',
    'Icon=weapp-container-devtools',
    'Terminal=false',
    'Categories=Development;',
    'StartupNotify=true',
    '',
  ].join('\n'))
  return packageRoot
}

export async function createDeb({ source, output, version, iconPath }) {
  if (process.platform !== 'linux') throw new Error('DEB packages must be built on Linux')
  const destination = resolve(output)
  const packageRoot = `${destination}.root`
  await mkdir(dirname(destination), { recursive: true })
  await rm(destination, { force: true })
  try {
    await buildDebRoot(source, packageRoot, version, iconPath)
    run('dpkg-deb', ['--build', '--root-owner-group', packageRoot, destination], dirname(destination))
    run('dpkg-deb', ['--info', destination], dirname(destination))
    return destination
  } finally {
    await rm(packageRoot, { recursive: true, force: true })
  }
}

export async function buildMacAppBundle({ source, output, version, iconPath, temporaryRoot }) {
  const app = resolve(output)
  const contents = join(app, 'Contents')
  const resources = join(contents, 'Resources')
  const executable = join(contents, 'MacOS/WeappContainerDevTools')
  const iconset = join(temporaryRoot, 'AppIcon.iconset')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await cp(source, resources, { recursive: true, dereference: true })
  const iconSizes = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ]
  await mkdir(iconset, { recursive: true })
  for (const [name, size] of iconSizes) {
    run('sips', ['-z', String(size), String(size), iconPath, '--out', join(iconset, name)])
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'AppIcon.icns')])
  const [major, minor, patch] = versionParts(version)
  const bundleVersion = `${major}.${minor}.${patch}`
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Weapp Container DevTools</string>
  <key>CFBundleExecutable</key><string>WeappContainerDevTools</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.weappcontainer.devtools</string>
  <key>CFBundleName</key><string>Weapp Container DevTools</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${bundleVersion}</string>
  <key>CFBundleVersion</key><string>${bundleVersion}</string>
  <key>WeappContainerReleaseVersion</key><string>${xml(version)}</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`)
  await writeFile(executable, '#!/bin/sh\nset -eu\nRESOURCES="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"\nexec "$RESOURCES/node/bin/node" "$RESOURCES/scripts/devtools-launcher.mjs" gui\n', { mode: 0o755 })
  await chmod(executable, 0o755)
  return app
}

export async function createDmg({ source, output, version, iconPath }) {
  if (process.platform !== 'darwin') throw new Error('DMG packages must be built on macOS')
  const destination = resolve(output)
  const temporaryRoot = `${destination}.tmp`
  const app = join(temporaryRoot, 'Weapp Container DevTools.app')
  const dmgRoot = join(temporaryRoot, 'image')
  await mkdir(dirname(destination), { recursive: true })
  await rm(temporaryRoot, { recursive: true, force: true })
  await rm(destination, { force: true })
  try {
    await mkdir(dmgRoot, { recursive: true })
    await buildMacAppBundle({ source, output: app, version, iconPath, temporaryRoot })
    await cp(app, join(dmgRoot, basename(app)), { recursive: true, dereference: true })
    await symlink('/Applications', join(dmgRoot, 'Applications'))
    run('hdiutil', ['create', '-volname', 'Weapp Container DevTools', '-srcfolder', dmgRoot, '-format', 'UDZO', '-ov', destination], dirname(destination))
    run('hdiutil', ['verify', destination], dirname(destination))
    return destination
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function createMsi({ source, output, version }) {
  if (process.platform !== 'win32') throw new Error('MSI packages must be built on Windows')
  const destination = resolve(output)
  const temporaryRoot = `${destination}.tmp`
  const productSource = join(temporaryRoot, 'product.wxs')
  const harvestedSource = join(temporaryRoot, 'files.wxs')
  await mkdir(dirname(destination), { recursive: true })
  await rm(temporaryRoot, { recursive: true, force: true })
  await rm(destination, { force: true })
  await mkdir(temporaryRoot, { recursive: true })
  try {
    await writeFile(productSource, renderMsiSource(version))
    runInstallerTool('heat.exe', ['dir', resolve(source), '-nologo', '-dr', 'INSTALLFOLDER', '-cg', 'DevToolsFiles', '-ag', '-scom', '-sreg', '-srd', '-var', 'var.SourceDir', '-out', harvestedSource], temporaryRoot)
    runInstallerTool('candle.exe', ['-nologo', `-dSourceDir=${resolve(source)}`, '-out', `${temporaryRoot}\\`, productSource, harvestedSource], temporaryRoot)
    runInstallerTool('light.exe', ['-nologo', '-out', destination, join(temporaryRoot, 'product.wixobj'), join(temporaryRoot, 'files.wixobj')], temporaryRoot)
    return destination
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function createPlatformInstaller({ target, source, output, version, iconPath }) {
  if (target === 'macos-universal') return createDmg({ source, output: `${output}.dmg`, version, iconPath })
  if (target === 'windows-x86_64') return createMsi({ source, output: `${output}.msi`, version })
  if (target === 'linux-x86_64') return createDeb({ source, output: `${output}.deb`, version, iconPath })
  throw new Error(`Unsupported installer target ${target}`)
}
