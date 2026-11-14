# `container-manifest`

[简体中文](README.md) · **English**


`container-manifest` converts a `wv build -p weapp` directory into the
versioned portable manifest consumed by the Weapp Container runtime. It does not rewrite
the original WeChat output, so the input directory remains importable by the
official DevTools.

Use Node 24.22.2. Sources follow repoctl's tsdown CLI / library templates. Builds generate `dist` and declarations; the npm package ships built artifacts. After installation, use the `container-pack` command and import APIs from `@sonofmagic/container-manifest` and its subpaths.

## CLI

```bash
pnpm install --frozen-lockfile
pnpm --dir tools/container-manifest build
node tools/container-manifest/dist/cli.mjs \
  ./path/to/weapp-dist \
  --out ./artifacts/reference \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
```

The output directory contains:

- `manifest.json`: canonical UTF-8 JSON, schema v1, modern View v2, or explicit renderer profiles v3;
- `blobs/sha256/<digest>`: content-addressed original modules, normalized
  WXML/WXSS IR, separately compiled WXS/WXML executables and assets;
- `capability-matrix.json`: host/engine support records used by `wx.canIUse`;
- `diagnostics.json`: stable warnings/errors from the input scan.

The manifest integrity root is the SHA-256 digest of its canonical form with
`integrity.root` set to the empty string. Canonical JSON sorts object keys by
their UTF-8 bytes and emits arrays in semantic order (routes preserve
`app.json` order; scanned resources are sorted by normalized POSIX path).

<a id="库-api"></a>
## Library API

```js
import { buildManifest, packContainer } from '@sonofmagic/container-manifest';

const result = await buildManifest('./dist');
await packContainer('./dist', './artifacts/reference');
```

`buildManifest` is side-effect free and returns `{ manifest, blobs,
diagnostics }`. `packContainer` refuses to write output when any diagnostic has
severity `error` and reports the structured `ERR_INVALID_MANIFEST` error.

The scanner recognizes `.js/.mjs/.cjs/.json`, `.wxml`, `.wxss/.css`, and
preserves all other files as assets. WXML and WXSS sources are parsed into
versioned, canonical JSON blobs before hashing. WXML blobs contain element,
text and comment nodes, sorted attributes, mustache bindings, and structured
control-flow/event directives matching Rust's `WxmlDirectives`. Original
attributes remain lossless. The Rust decoder also normalizes attribute-only
source blobs from earlier v1 packers; explicit directives and evaluated
key/binding metadata remain authoritative so repeats are not reconstructed.
WXSS blobs use IR v2 and contain selectors, declarations (including
`!important`) and nested at-rules. Each import is an empty-bodied at-rule in
the ordered `rules` array; the legacy `imports` array stays empty. Import
source positions and enclosing groups are preserved, including placements
that the runtime will explicitly reject when active. Declaration bodies such
as `@font-face` stay separate from nested rule lists. Parsing an at-rule does
not claim that its execution or rendering is supported. The manifest schema
remains v1 for legacy packs; the Rust decoder continues to read legacy WXSS IR v1. See
[the WXSS contract](../../docs/wxss-ir.en.md) for compatibility boundaries.
The `wxmlAst`/`wxssIr` manifest fields point to those blobs with
`sha256:<digest>` pointers. `usingComponents` entries from app/page/component
config are emitted as deterministic relation records. Missing optional
`app.js` is a warning, while missing or invalid `app.json`, WXML or WXSS is an
error. CommonJS `require("./module")` and ESM `import`/`export ... from`
references are scanned lexically and emitted as optional `modules[].dependencies`
arrays containing `module:<path>` IDs. Relative, root-relative and emitted
`miniprogram_npm`/`node_modules` paths are resolved with the same extension and
`index` fallbacks used by the packer. A static reference that does not resolve
to an emitted module produces `ERR_UNDECLARED_MODULE_DEPENDENCY` and prevents
writing a pack; manifests produced before dependency extraction remain valid
because an empty dependencies field is omitted from canonical JSON.

AppService `.js` modules containing static `import` or `export` declarations
are classified as `esm`; other `.js` modules remain `commonjs`. Classification
uses the JavaScript parser, so comments, strings, template/regular-expression
literals, property names and dynamic `import()` alone do not select ESM.
Unparseable `.js` source produces an `ERR_INVALID_MANIFEST` diagnostic naming
the AppService module before a pack can be published. Explicit `.mjs` and
`.esm.js` suffixes remain ESM, `.cjs` remains CommonJS, and `.json` remains JSON.
Module bytes are not rewritten, and dynamic import support is unchanged.

WXS uses a separate grammar-aware dependency pass with the exact Acorn version
in `pnpm-lock.yaml`. It parses Script grammar through ECMAScript 2020, without
executing or rewriting input bytes. Division and regular-expression literals
are distinguished by the parser; require-shaped strings, comments and regexes
cannot create phantom module edges. Escaped identifiers and string literals
are decoded before resolving direct `require("./dependency.wxs")` calls.
Inline and external sources use the same pass. Dependencies are deduplicated,
sorted and restricted to canonical, declared relative `.wxs` files.

Dynamic/aliased lexical `require`, loader shadowing and dynamic-code forms such as
`eval`, `Function`, `with` and imports are rejected explicitly. Parser acceptance
does not certify the official WXS dialect. This pass is not a JavaScript
sandbox or proof against arbitrary reflection; native View still enforces the
declared dependency whitelist when loading modules. AppService's module pass
remains the separate lexical scanner described above.
For example, a factory's `arguments[2]` can obtain the loader without a lexical
`require` reference. The graph pass does not discover that edge; native View
rejects the load unless it was already declared. A shared QuickJS/V8 regression
checks both the rejected and declared cases, including lexical arrow capture.

The admitted WXS syntax is lowered separately from graph extraction, together
with WXML expressions. Optional `viewCompilation` records compiler
`weapp-container-wxs` version `1.0.0` and helper ABI `1.0`:

```ts
{
  compiler: "weapp-container-wxs", version: "1.0.0", abi: "1.0",
  modules: [{ id, sourceSha256, executableSha256, helper }],
  documents: [{ documentId, wxmlAst,
    expressions: [{ source, shorthand, executableSha256, helper }] }]
}
```

Original source bytes and their hashes remain unchanged. Executable blobs have
separate SHA-256 identities, and the compiler/ABI metadata participates in the
manifest integrity root and runtime reload identity. Hosts must copy, validate
and preload the entire closure, including module source/executables and WXML
expression executables. Missing or corrupt bytes cannot become a successful
initialization.

Compiled property reads expose the eight standard string-valued WXS constructor
names without modifying native prototype constructors. A hygienic lexical
helper preserves own/inherited overrides, getters, method receiver and argument
order, strict writes, compound/update/delete operations and `for-in` writes.
Native Array methods keep their native behavior. Direct View API source without
compilation metadata remains ECMAScript; this pack format does not silently
rewrite that public boundary.

Unsupported syntax returns `ERR_UNSUPPORTED_WXS_SYNTAX` and prevents publishing
a pack: lexical `eval`/`Function`, `with`, imports, optional operations,
async/generators, tagged templates, classes, destructuring, spread/rest and
`for-of`. Acceptance is an implementation subset, not proof of the complete
official WXS dialect or a reflection sandbox. A bare `wx:key` is literal
property metadata, so names such as `class` or `first-name` are not parsed as
code. `*this` retains its item-value meaning; the existing dotted loop-scope
expression extension remains compiled and explicitly outside official parity.

Run `pnpm runtime:wxs-graph:smoke` for the raw fixture → portable pack → native
QuickJS/V8 View integration check. It verifies unchanged WXS source blobs and
the rendered dataset. It does not supply official DevTools evidence.
`pnpm runtime:wxs-dialect:smoke` also verifies separate source/executable hashes
and actual constructor, Array-method, inline/external WXS and WXML dataset
results on both native engines. The version-pinned official constructor oracle
remains `unknown`; these local checks do not establish host/GPU/device or
performance acceptance.

The Rust `container-ir` crate exposes matching `parse_wxml`/`parse_wxss` and
`decode_wxml`/`decode_wxss` functions. This lets each host validate the blob
format before handing the tree to View/Renderer, without reparsing source
markup at runtime.

<a id="仅容器的现代视图"></a>
## Container-only modern View

Pass `--project <source-project>` to opt into `container.config.json`:

```json
{
  "view": {
    "documents": {
      "pages/home/index.wxml": {
        "mode": "modern",
        "modules": { "fmt": "./view/format.view.ts" }
      }
    }
  }
}
```

Document keys identify emitted WXML paths. Entries identify project-relative
`.view.ts`/`.view.js` files. Modern WXML calls those namespaces directly, for
example `{{fmt.label(user?.name ?? 'guest')}}`, without a `<wxs>` declaration.
Legacy documents continue to use the existing WXS dialect. Import/include
edges cannot cross the language boundary.

```bash
node tools/container-manifest/bin/container-pack.mjs ./app/dist \
  --out ./artifacts/modern --project ./app
```

The pinned public Rolldown API erases TypeScript and links static ESM,
synchronous CommonJS and JSON dependencies into a single ES2022 executable per
connected WXML graph. Aliases and imported templates in that graph share ESM
live bindings and cycles. Synchronous npm packages are supported when all their
linked dependencies satisfy the same policy; their source identities include
package name and version. Classes, destructuring, spread, optional/nullish
operations, generators and native ECMAScript constructor behavior remain
standard ECMAScript, without WXS constructor lowering.

These packs explicitly use `schemaVersion: 2` and `modernView` compiler/ABI
metadata. Executable code, source maps with original `sourcesContent`, raw
sources and config bytes are separate content-addressed blobs covered by the
integrity root. Paths and hashes are reproducible across development snapshots.
The raw `wv build` output is unchanged. Missing config keeps an exact v1 pack;
modern View is a container extension and does not make modern syntax runnable
in official WeChat DevTools.

View execution is synchronous. Async functions, `await`, promises, dynamic
imports, timers, network/storage/browser/Node/AppService globals, native addons
and `.wxs` dependencies fail before pack publication. Module loading in WXML
expressions is also rejected; use configured aliases. This static policy does
not replace runtime isolation or prove safety against arbitrary reflection.
Type erasure does not perform type checking; run the project's independent
TypeScript check as a separate gate.

Development tools may pass `--resolve-root <original-project>` while packing an
immutable source snapshot to resolve installed npm dependencies from that
project. `--config <path>` selects a project-relative config;
`--diagnostic-json <file>` saves structured failure diagnostics, including
source `path` and parser location in `details`. Invalid inputs never publish a
pack. `buildManifest(input, {project, configFile, resolveRoot})` exposes the same
behavior through the library API.

`--watch-dependencies-json <file>` explicitly writes a development sidecar
`{schemaVersion:1,sources:[{path,sha256}]}` with resolved absolute source paths,
including linked npm files. This report stays outside the manifest/runtime ABI;
publish the portable pack without this machine-specific watch report.

<a id="能力覆盖"></a>
## Capability overrides

Pass either a compact map or a matrix JSON file:

```json
{ "wx.request": "full", "wx.requestPayment": "unsupported" }
```

Every status is one of `full`, `partial`, or `unsupported`. Unsupported APIs
must be surfaced by the runtime as `ERR_UNSUPPORTED_CAPABILITY`; this packer
does not silently invent host implementations.
