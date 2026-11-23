# Weapp Container DevTools

This archive contains the directly runnable Weapp Container development tools.

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
sudo apt install libgl1 libx11-6 libxkbcommon0 libfontconfig1
```

The Web Player does not require a desktop session.

The archive is a preview release. Check `weapp-devtools.json` for the exact source commit, compiler commit, Node version, target, and file hashes.
