<a id="flex-布局测试-fixture"></a>
# Flex layout fixture

[简体中文](README.md) · **English**


Run the app in the development simulator:

```sh
pnpm simulator:dev -- --project examples/apps/flex-layout-app --viewport 360x800
```

The fixed 360 × 800 verification viewport covers default row flow, proportional
growth, shrinking, wrapping, alignment, nested containing-block percentages,
min/max constraints, assigned-width text measurement and absolute/fixed boxes.
The bottom controls use actual Page handlers to change wrap width, scroll the
page 100px, and record selector/lifecycle results in `flex:observation` storage.
The blue viewport-fixed square remains clickable after scrolling. The scrolled
phase does not inject a render commit, so it also checks automatic frame updates.

`pnpm runtime:flex:smoke` builds original output with a verified pinned compiler
and compares three QuickJS/V8 phases and complete native CPU RGBA. Supply its
compiler and simulator paths as described by the command's required options.
This local fixture uses `touristappid`; it is not an official DevTools run.
Official execution needs a separately configured real AppID and the fixed
IDE/SDK baseline. No GPU, device, performance or near-parity result follows
from this fixture alone.
