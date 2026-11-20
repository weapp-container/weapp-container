# Weapp Container

[简体中文](README.md) · **English**

An independent open-source portable runtime for loading mini-program-shaped pages, components, scripts, and styles in a controlled process. The repository contains a manifest packer, Rust runtime, QuickJS/V8 engines, a simulator, and Node test bindings.

This project has no affiliation, authorization, or commercial relationship with any third-party platform, brand, service, or SDK. The repository provides only a portable runtime, manifest format, and compatibility identifiers. It contains no official tools, native platform SDKs, account system, or external-service bridge; callers own any external permissions and network behavior.

## Quick start

```sh
pnpm install
pnpm container:manifest:test
pnpm conformance:verify
pnpm api:inventory:verify
```

The Node bindings consume source directories or prebuilt portable packs. Callers choose and manage any compiler, host service, or external network integration themselves.

## License

Apache-2.0. See [NOTICE](NOTICE) and [SECURITY.md](SECURITY.md).
