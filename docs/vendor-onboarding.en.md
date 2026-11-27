# Vendor mini-program quickstart

[简体中文](vendor-onboarding.md)

Use Node.js 24 and a DevTools preview build that supports host fixtures. Install the two npm archives from the preview artifacts into a dedicated tooling directory.

```sh
mkdir -p vendor-tooling
npm install --prefix ./vendor-tooling /absolute/path/to/sonofmagic-container-manifest-0.1.0.tgz /absolute/path/to/weapp-container-agent-0.1.0.tgz
export PATH="$PWD/vendor-tooling/node_modules/.bin:$PATH"
weapp-container-agent create --project ./my-mini-program --name "My Brand"
cd my-mini-program
npm install
```

Edit the navigation title and colors in `src/app.json`. Edit the homepage content and logo path in `src/pages/index/brand.js`. Place brand images in `src/assets/` and set `logo` to an app-relative path such as `/assets/logo.png`. Set global and page colors in the corresponding WXSS files.

```sh
weapp-container-agent preview start --project . --simulator-bin /absolute/path/to/bin/weapp-simulator --host-fixtures preview/host-fixtures.json
weapp-container-agent preview status --project .
weapp-container-agent build --project . --out ../portable-pack --json
weapp-container-agent preview stop --project .
```

Open the `url` shown by preview. Host fixtures map names to responses, for example `{"company.getProfile":{"resolve":{"displayName":"Preview user"}}}` or `{"company.getProfile":{"reject":"Profile access denied"}}`. Restart preview after editing the fixture. If a build fails, check the preview log and save a fix to trigger a rebuild.

`build --out` requires a fresh destination. Record the reported `integrityRoot` and give the full pack directory to each host. Register `company.getProfile` before loading the pack and let the host application handle identity and permissions. [Runnable Android and iOS examples](../examples/hosts/vendor-onboarding/README.md)

For an existing project, run `weapp-container-agent inspect --project /path/to/project --json`. Look at `diagnostics` for suggested fixes and `compatibility.findings` for source locations and evidence. Install the project's weapp-vite dependencies, then use the same preview and build commands. You can also open the existing project folder directly in DevTools.
