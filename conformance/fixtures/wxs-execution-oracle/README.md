# WXS execution fixture

This hand-authored fixture exercises the portable WXS/WXML pipeline. It
contains source and scenario data only; it does not connect to external
developer tools or claim platform conformance.

The scenarios cover lifecycle callbacks, same-value updates, branches, keyed
rows, imports, slots, style changes, and datatype probes. Pack the `raw/`
directory with the repository's manifest tool and run it through the local
QuickJS or V8 engine when investigating a change.
