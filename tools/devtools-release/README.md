# Weapp Container DevTools

This package contains the directly runnable Weapp Container development tools.

## Install the desktop package

The GitHub Release provides an installer for each desktop platform.

- macOS: open the `.dmg` and drag `Weapp Container DevTools.app` to Applications. This preview build is unsigned, so macOS may require opening it from Finder with Control-click and Open.
- Windows: run the `.msi` installer and use the Start Menu shortcut. Windows may show an unsigned publisher warning for this preview build.
- Debian or Ubuntu: install the `.deb` with `sudo apt install ./weapp-container-devtools-linux-x86_64.deb`, then launch `Weapp Container DevTools` from the application menu or run `weapp-devtools`.

The portable `.tar.gz` and `.zip` packages remain available for environments where an installer is not suitable.

## Start the graphical launcher

Run `bin/weapp-devtools` on macOS or Linux, or `bin/weapp-devtools.cmd` on Windows. The launcher opens a local browser window where you can choose an existing `weapp-vite` project and start either the Web Player or Desktop Player.

The project must already have its normal application dependencies installed. The archive includes the fixed `weapp-vite` compiler, its production dependencies, Node.js, the manifest packer, and the renderer resources used by the simulator.

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

This is a preview release. Check `weapp-devtools.json` for the exact source commit, compiler commit, Node version, target, and file hashes.
