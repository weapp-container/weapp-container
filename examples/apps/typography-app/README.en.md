<a id="字体固定装置"></a>
# Typography fixture

[简体中文](README.md) · **English**


Run `pnpm simulator:dev -- --project examples/apps/typography-app --surface web`.
The two top labels inherit a numeric or percentage line height. “resize text”
changes the parent's font size through the actual Page handler; “inspect” stores
the committed selector results in `typography:observation`.

The fixture also includes explicit newlines, zero line height with visible ink,
and zero font size. `pnpm runtime:typography:smoke -- --simulator-bin …
--compiler-root … --compiler-dist-hashes … --out …` builds it with the pinned
compiler and compares native QuickJS/V8 runs. This is local runtime evidence;
official WeChat typography, full shaping, GPU and device parity remain separate
acceptance requirements.
