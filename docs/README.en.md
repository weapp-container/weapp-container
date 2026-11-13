<a id="文档索引"></a>
# Documentation index

[简体中文](README.md) · **English**


Start with the [quick start](https://container.weapp.dev/en/docs/start/) when integrating for the first time. This directory explains runtime implementation and engineering boundaries. The website publishes fixed snapshots of these engineering documents.

<a id="接入与开发"></a>
## Integration and development

- [Standalone packer](../tools/container-manifest/README.en.md): convert native mini-program directories or existing framework builds to portable packs.
- [SDK repositories and source builds](sdk-repositories.en.md): targets, runtimes, wrappers, and artifact licensing.
- [Simulator](simulator.en.md) and [device client](dev-player.en.md): development previews, input, device connections, and diagnostics.
- [Host services](host-services/README.en.md): capability negotiation, lifecycle, messaging, permissions, and validation.

<a id="实现与协议"></a>
## Implementation and protocols

- [Architecture](architecture.en.md), [AppService execution](appservice-execution.en.md), and [isolated View engine](isolated-view-engine.en.md).
- [Layout](layout-flow.en.md), [text](typography.en.md), [images](images.en.md), [scrolling](scrolling.en.md), [transforms](transforms.en.md), and [compositing](compositing.en.md).
- [Dual rendering](dual-renderer/README.en.md): browser DOM, Skia, presentation acknowledgments, and input ownership.
- [Renderer profiles](renderer-profiles.en.md), [resource storage](render-resource-store.en.md), and [performance](performance.en.md).

<a id="兼容性发行与协作"></a>
## Compatibility, releases, and collaboration

- [Capability matrix](capability-matrix.en.md), [API conformance](api-runtime-conformance.en.md), and [official-tool validation](conformance/README.en.md).
- [Build dependencies](rust-build-cache.en.md), [platform archives](platform-runtime-artifacts.en.md), and [release tooling](../tools/runtime-artifacts/README.en.md).
- [Licensing](licensing.en.md), [public source policy](public-source-policy.en.md), [archived evidence](archived-evidence.en.md), and [legacy archive migration](runtime-artifacts-migration.en.md).
- [Contributing](../CONTRIBUTING.en.md), [security reports](../SECURITY.en.md), and [code of conduct](../CODE_OF_CONDUCT.en.md).

Implementation, build, runtime, and acceptance describe different levels of evidence. Unit tests, source coverage records, or results from one host do not establish acceptance on other platforms. Unknown behavior remains explicitly unverified.
