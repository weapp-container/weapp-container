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
