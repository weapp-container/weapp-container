# Weapp Container scrolling fixture

This source app exercises two independent scroll views with both axes enabled,
data-driven scroll commands, wheel and touch input, coordinate taps, selector geometry,
intersection observation, page scrolling and navigation cleanup. Its colored
rectangles make movement and clipping measurable in actual rendered pixels.

Run `node scripts/scrolling-smoke.mjs --help` for the pinned compiler → portable
pack → native QuickJS/V8 regression. The smoke calls the compiled application's own
event handlers. Observations are written by the app to `scroll:query` and
`scroll:taps` storage keys, then read through the real `wx` provider. It never
injects expected page data or a handcrafted render frame.
This is local conformance evidence; no fresh official DevTools or device result
is implied.

The A scroll view's ordinary `bindtouchmove` handler calls `stopPropagation`;
its default drag still scrolls. The C scroll view, revealed after page scroll,
uses `catchtouchmove` and records the handler without calling `preventDefault`;
that drag must leave both C and its ancestors unchanged.

```sh
node scripts/scrolling-smoke.mjs \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root /path/to/isolated/pinned/weapp-vite \
  --compiler-dist-hashes /path/to/independent/compiler-dist-sha256.json \
  --out artifacts/scrolling.json
```

The compiler source is checked against every Git object at the repository's
submodule pin, with explicitly declared CRLF conversions recorded separately.
The compiler dist is checked before and after compilation against the supplied
SHA-256 map from an independent compiler build. This command reuses that
compiler and its installed dependencies; it does not claim a new compiler
build or dependency installation. Only a temporary project copy is built.

The first page deliberately shares the `.control` class name with the second
page. Route style selection must keep the second page's declarations out of
the first page; renaming the class is not a fix for a leaking host stylesheet.
