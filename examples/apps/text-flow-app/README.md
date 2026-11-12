# Text flow fixture

```sh
pnpm simulator:dev -- --project examples/apps/text-flow-app --viewport 320x680
```

The control at `(8, 600)` runs the Page's `onToggle` handler. `setData` changes
the first two samples from `normal / normal / start` to
`break-spaces / break-all / right`; a second tap restores the initial styles.
The control at `(168, 600)` stores real selector geometry, computed flow styles,
Page data and lifecycle history in `text-flow:observation`.

Every sample uses a binding inside `<text>`. The unchanged source contains
leading/trailing and repeated spaces, a tab, CRLF, a long Latin word, CJK and
combining/ZWJ/regional-indicator sequences. Static samples cover six white-space
values, three word-break values and five text-align values. The viewport and
all sample widths are fixed; no host injects geometry or substitutes Page data.

These samples exercise the shared text plan and source mapping. They do not
establish full inline formatting, bidi, font shaping, official glyph metrics or
parity. Unbound formatting whitespace outside `<text>` retains the existing
WXML filtering boundary. The tourist AppID is for local development; an official
oracle must copy the unmodified build to an owned project with a real AppID,
verify IDE `2.02.2608080` / SDK `3.17.3`, and retain its own observations.
