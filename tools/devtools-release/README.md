# Weapp Container DevTools

This package contains the directly runnable Weapp Container development tools.

Stable packages are built from a fixed compatibility matrix. The launcher checks
`project.config.json`, the source `app.json`, compiler identity, and project
dependencies before starting a player. The supported source projects are the
three community examples and `examples/apps/shop-demo`.

## Install the desktop package

The GitHub Release provides an installer for each desktop platform.

- macOS: open the `.dmg` and drag `Weapp Container DevTools.app` to Applications.
- Windows: run the `.msi` installer and use the Start Menu shortcut.
- Debian or Ubuntu: install the `.deb` with `sudo apt install ./weapp-container-devtools-linux-x86_64.deb`, then launch `Weapp Container DevTools` from the application menu or run `weapp-devtools`.

The portable `.tar.gz` and `.zip` packages remain available for environments where an installer is not suitable.

## Launch an unsigned prerelease

The current GitHub prerelease macOS and Windows packages are unsigned. Download only from the matching GitHub Release and verify the installer or archive against its `SHA256SUMS` entry before bypassing an operating-system warning.

On macOS, open the `.dmg` and copy `Weapp Container DevTools.app` to Applications before running:

```sh
shasum -a 256 "$HOME/Downloads/weapp-container-devtools-macos-universal.dmg"
xattr -dr com.apple.quarantine "/Applications/Weapp Container DevTools.app"
open "/Applications/Weapp Container DevTools.app"
```

`xattr` removes only the app's quarantine metadata. It does not add a Developer ID signature or notarization. Replace the path when the app is installed elsewhere. Do not disable Gatekeeper globally.

For the Windows MSI, verify the hash and remove the downloaded-file Zone Identifier in PowerShell:

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi" -Algorithm SHA256
Unblock-File -Path "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi"
Start-Process "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi"
```

Run `Unblock-File` on a ZIP before extracting it. If SmartScreen still appears, select **More info** > **Run anyway** only after verifying the release source and hash. `Unblock-File` does not add an Authenticode signature. Do not disable Defender or SmartScreen globally. Platform-signed stable packages, with notarization on macOS, should not require these manual steps.

## Start the graphical launcher

Run `bin/weapp-devtools` on macOS or Linux, or `bin/weapp-devtools.cmd` on Windows. The launcher opens a local browser window where you can choose an existing `weapp-vite` project and start either the Web Player or Desktop Player.

The archive includes the fixed `weapp-vite` compiler, its production dependencies, Node.js, the manifest packer, and the renderer resources used by the simulator. The selected project must have its declared dependencies installed. Use the bundled `pnpm` command in the package when the launcher reports missing dependencies.

## Command line

```text
bin/weapp-devtools dev --project /absolute/project --surface web
bin/weapp-devtools dev --project /absolute/project --surface desktop
```

The Web Player listens on a local loopback port and can be opened from the launcher logs. Desktop Player requires a graphical session on the host operating system.

On Ubuntu 22.04 or 24.04, Desktop Player also requires the system OpenGL, X11,
XKB, and fontconfig libraries. Install them if they are not already present.

```sh
sudo apt install libgl1 libx11-6 libxkbcommon0 libfontconfig1 xdg-utils zenity
```

The Web Player does not require a desktop session.

Check `weapp-devtools.json` for the exact source commit, compiler commit, Node version, target, compatibility matrix, and file hashes. Stable packages expose a signed update manifest. Stable macOS packages require a Developer ID application signature and notarized DMG. Stable Windows packages require Authenticode signing. The release workflow stops before publishing when those signing inputs are missing. Preview packages do not participate in stable updates.

## Stable release signing

The release workflow imports signing material only on ephemeral GitHub-hosted runners. Configure these repository secrets before pushing a stable `devtools-vX.Y.Z` tag.

- macOS: `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_BASE64`, `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_PASSWORD`, `WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD`, `WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY`, `WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_BASE64`, `WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_ID`, and `WEAPP_DEVTOOLS_MACOS_NOTARY_ISSUER`.
- Windows: `WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_BASE64` and `WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_PASSWORD`.
- Update metadata: `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY` and the repository variable `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY`.

The certificate and App Store Connect API key values are base64-encoded files. The workflow verifies the signed app, notarized DMG, Authenticode MSI, and signed update manifest before the GitHub release is created.

### Obtain the signing material

Enroll the organization in the Apple Developer Program. Create a **Developer ID Application** certificate in the Apple Developer account, install it in Keychain Access, and export the certificate with its private key as a password-protected `.p12` file. The signing identity value is the exact identity shown by `security find-identity -v -p codesigning`.

Create a **Team** API key in App Store Connect under **Users and Access > Integrations > App Store Connect API**. Download its `.p8` file and record the Key ID and Issuer ID. Apple only provides the private key file once. The release workflow uses it with `notarytool` to submit the DMG for notarization.

Obtain a publicly trusted Authenticode code-signing certificate from a certificate authority after completing its organization identity checks. This workflow expects an exportable `.pfx` file containing the private key and its password. A hardware-token-only or cloud signing key cannot be supplied as this PFX and requires a different signing integration.

The update-manifest Ed25519 key is generated by the project maintainer, not issued by a platform. Generate it once from a protected directory outside this repository and retain an encrypted backup of the private key:

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync('weapp-devtools-update-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync('weapp-devtools-update-public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
NODE
```

Store the private PEM as `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY` and the public PEM as the repository variable `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY`. Keep this key pair for future stable updates. Installed clients trust the public key embedded in their release.

Add the values in the core repository's **Settings > Secrets and variables > Actions**. The `.p12`, `.p8`, and `.pfx` values must be base64-encoded before they are entered. Create a strong `WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD` in a password manager. Do not commit signing files or send private keys, certificate passwords, or API keys in chat. See the [public SDK release guide](../../docs/public-sdk-release.md) for the CocoaPods Trunk token setup and the exact SDK repositories that need it.
