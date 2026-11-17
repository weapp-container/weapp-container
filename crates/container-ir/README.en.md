# container-ir

[简体中文](README.md) · **English**


Portable manifest, WXML and WXSS data models shared by the packer, runtime and
host adapters. This crate contains no engine or renderer handles.

<a id="wxss-blob-版本"></a>
## WXSS blob versions

`parse_wxss` emits WXSS IR v2. Imports are empty-bodied `WxssRule` entries
with `atRule: "@import ..."` at their original source position and nesting;
the legacy `imports` array is empty. Group bodies and declaration bodies
remain distinct, so import-only media groups are not hoisted and `@font-face`
descriptors are not parsed as selectors. Unknown at-rules remain inspectable.

`decode_wxss` and `validate_wxss` accept v1 and v2. V1's separate imports list
does not contain enough information to reconstruct source order or enclosing
conditions. V2 rejects an ambiguous nonempty imports list and import rules
with declarations or nested children. Blob versions are independent from the
enclosing manifest schema version, which remains 1.

The selector cascade skips unresolved at-rule subtrees. The runtime must first
resolve imports and flatten matching conditional groups; false media branches
and keyframe selectors cannot accidentally become ordinary element styles.
Rust and the JavaScript packer share canonical JSON fixtures. See
[the WXSS contract](../../docs/wxss-ir.en.md) for conditional evaluation and
remaining parser/runtime boundaries.

<a id="边界声明和级联"></a>
## Border declarations and cascade

The render-style resolver expands `border`, `border-top/right/bottom/left` and
the `border-width/style/color` quads before comparing importance, selector
specificity, inline declarations and source order. The winning render properties
are the twelve `border-{top|right|bottom|left}-{width|style|color}` longhands.
Shorthands remain available for inspection; painting must consume the independently
cascaded longhands rather than reapply those shorthands in map order.

Each whole-border or edge shorthand resets omitted components to `3px` (`medium`),
`none` and `currentcolor`. Width keywords normalize to `thin=1px`, `medium=3px`
and `thick=5px`. The supported length subset is nonnegative `px`, `rpx`, `rem`,
`vw`, `vh` and unitless zero. Percentages, `auto`, negative widths and nonzero
unitless widths are rejected. A malformed shorthand or longhand contributes no
render declaration, so an invalid late `!important` cannot erase an earlier valid
value. The source IR still preserves its original declarations.

Quads follow top/right/bottom/left order, including the usual one-, two- and
three-value replication. Value tokenization preserves nested functions, quoted
strings and escapes; whitespace inside `rgb(...)` or `rgba(...)` cannot split a
color into multiple border components. Comments separate declaration tokens.

The shared color parser accepts CSS named colors (including aliases and
`rebeccapurple`), `transparent`, 3/4/6/8-digit hex, legacy comma-separated
RGB/RGBA and modern space-separated RGB/RGBA with optional slash alpha. Numeric
and percentage channels use CSS clamping and round to 8-bit RGBA. Legacy channel
units must be homogeneous. `currentcolor` is preserved as a symbolic border
value: runtime style computation resolves it against the element's foreground;
the context-free RGBA parser deliberately returns no color for that keyword.

The foreground `color` declaration uses this same portable color set plus
`currentcolor`, `initial`, `inherit` and `unset`. Invalid foreground declarations
do not enter the render cascade: a later malformed color cannot replace an
earlier valid value or prevent inheritance from the parent. Other legitimate
CSS color spaces such as HSL, Lab and display-P3 are outside this portable set
and do not enter the render cascade either; they are not rendered as black.
The source IR retains those declarations for inspection and future capabilities.

`initial`, `inherit` and `unset` expand to the appropriate border longhands.
Their inherited or initial computed values belong to the runtime style resolver.
`box-sizing` accepts `content-box`, `border-box` and those three global keywords;
invalid values cannot win the portable cascade.

<a id="显式边界"></a>
## Explicit boundaries

The IR retains all ten standard border styles. Painting currently targets
`solid`, `none` and `hidden`. `dotted`, `dashed`, `double`, `groove`, `ridge`,
`inset` and `outset` remain distinct values so a renderer can explicitly report
unsupported behavior instead of painting them as solid.

This is a bounded render cascade, not a complete CSS implementation:

- `border-image` and the border shorthand's CSS reset of border-image longhands
  are not modeled. Border-image rendering and reset conformance are excluded.
- `revert` and `revert-layer` do not participate in the portable border cascade.
  There is no origin/layer rollback model, so they are not approximated by an
  initial-value reset.
- `calc`, custom-property substitution, other length units, HSL and other color
  spaces, relative colors and the `none` channel keyword are not accepted by
  this border normalization subset.
- Logical borders, tables' collapsed-border rules and browser-specific defaults
  need separate capabilities and evidence.

Parser and cascade unit tests establish this IR contract. They do not establish
WeChat DevTools parity, native GPU rendering or device behavior.
