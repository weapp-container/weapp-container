# Weapp Container

[简体中文](README.md) · **English**

An independent open-source portable runtime for loading mini-program-shaped pages, components, scripts, and styles in a controlled process. It also accepts unpacked, unencrypted mini-game output through a schema-v4 manifest, with a Canvas 2D subset and host-delivered platform-neutral game events. The repository contains a manifest packer, Rust runtime, QuickJS/V8 engines, a simulator, and Node test bindings.

This project has no affiliation, authorization, or commercial relationship with any third-party platform, brand, service, or SDK. The repository provides only a portable runtime, manifest format, and compatibility identifiers. It contains no official tools, native platform SDKs, account system, or external-service bridge; callers own any external permissions and network behavior.

## Quick start

```sh
pnpm install
pnpm container:manifest:test
pnpm conformance:verify
pnpm api:inventory:verify
```

The Node bindings consume source directories or prebuilt portable packs. Callers choose and manage any compiler, host service, or external network integration themselves.

## Mini-games

Pack and run an unpacked mini-game build with the QuickJS simulator:

```sh
pnpm container:pack -- ./game-dist --game --out ./artifacts/game
cargo run -p container-simulator --features quickjs-native -- \
  run --pack ./artifacts/game --snapshot ./artifacts/game/snapshot.json
```

This path requires `game.json` and `game.js`. It does not decrypt platform packages. The portable game runtime provides a Canvas 2D subset, frame scheduling, and normalized host events through `game.event` for touch, keyboard, sensor, audio interruption and memory warnings. App visibility uses `app.lifecycle`; viewport updates resize the game Canvas and notify `wx.onWindowResize`. Event payloads follow [`schemas/game-event-v1.schema.json`](schemas/game-event-v1.schema.json). API support remains capability-negotiated. Official DevTools, GPU and device parity remain unverified.

## Open-source mini-program examples

`examples/apps/community/` contains three curated runnable snapshots: a WeChat official text page, an Ant Design Mini button component, and a Taro blended-basic page. Each sample retains its upstream MIT license. Its directory guide and `SOURCES.json` record the repository, pinned commit, and local adaptations.

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/community/official-text" -p weapp \
  --outDir "$PWD/artifacts/community/official-text/raw"
pnpm container:pack -- artifacts/community/official-text/raw \
  --out artifacts/community/official-text/pack \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
pnpm simulator:dev:smoke -- \
  --project examples/apps/community/official-text
```

Replace `official-text` with `ant-design-button` or `taro-blended` for the other samples. See [`examples/apps/community/README.en.md`](examples/apps/community/README.en.md) for the complete sample list, commands, and source records.

To keep the simulator running in a browser:

```sh
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/community/official-text --surface web
```

## License

Apache-2.0. See [NOTICE](NOTICE) and [SECURITY.md](SECURITY.md).
