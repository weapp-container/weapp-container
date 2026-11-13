<a id="dom-button-基础适配"></a>
# DOM button basic adaptation

[简体中文](dom-button.md) · **English**


DOM presenter maps `button` that has evaluated `ViewDocument` to real HTML
`<button type="button">`. shared WXML, component/slot ownership, stable occurrence, typed attributes and
The event protocol remains as is. This adaptation is reused by both the remote DOM and the Browser Worker DOM path.

This page defines the local base contract of the container; the default appearance, keyboard and disabled behavior are not yet official DevTools
oracle. Node contracts use DOM/RPC doubles and do not represent real browser, hardware, or near-parity access.

<a id="支持边界"></a>
## Support borders

| Properties/Content | Behavior |
| --- | --- |
| Text, `text/view/image` and other non-independent control subtrees | Retain the evaluated content, style and declaration ownership, and do not re-execute View/WXS |
| `type` | `default`, `primary`, `warn`, when omitted `default`, only controls appearance |
| `size` | `default`, `mini`, when omitted `default` |
| `plain` | Basic appearance with transparent background and border |
| `disabled` | native disabled input fence with local ancestors; child nodes cannot be bypassed |
| `loading` | CSS busy indication and `aria-busy`, not automatically set disabled |
| `id/class/style/hidden/data-*/aria-*/role/tabindex` | Reuse existing DOM attributes and style boundaries; internal `data-wc-*` attributes are still prohibited from being provided by applications |

Boolean attributes follow existing typed precedence rules and `truth` conversion: typed values overwrite legacy strings of the same name;
By default, `null`, `false`, `0`, and string `"false"` are false, and other legal scalars are processed according to existing rules.
There is no new set of official Boolean semantics here. Object/array is not a control scalar property.

`button/input` or descendants with `tabindex` in the button are rejected during the entire document pre-flight stage, including components.
Descendants of packaging; this check occurs earlier than candidate iframe creation and any image resource acquisition to avoid nested independent controls.
Undefined native default behavior. Normal descendants can still bind the tap/touch event.

Host special attributes such as `open-type`, `form-type`, `hover-class`, `session-from` and others not listed
Button properties all return `ERR_UNSUPPORTED_CAPABILITY`, including empty `open-type`. Unknown type/size
Also refused. Basic button events only include tap, touchstart/move/end/cancel, focus/blur;
The button's own input/confirm/scroll binding is explicitly rejected. There is no empty implementation of sharing, login, payment, form submission/reset, etc.

<a id="浏览器事件和样式"></a>
## Browsers, events and styles

Native button retains browser keyboard focus, Enter/Space activation and basic accessibility roles; native click
Enter the existing batch tap distribution without additional input confirm synthesized by keydown. Buttons carry reality
disabled status and corresponding `aria-disabled`, `aria-busy`; the application can provide `aria-label`.
The focus of the button with the same occurrence on the same page is restored after the new candidate is rendered, and the button is disabled after the update.
will not regain focus.

disabled button and its descendants tap, touch and keyboard activation in browser capture entry with presenter
All batch processing entries are intercepted synchronously, the parent capture/bubble handler is not triggered, and gesture contacts are not established.
The loading button is still interactive. Enable button to continue using existing dataset/ component/slot ownership and
capture/target/bubble/catch sequence; the synchronous propagation of catch and the default cancellation strategy of touchmove remain unchanged.

WXML `type` does not write the HTML type value; the native type is always `button` and will not borrow appearance
The
value triggers a commit or reset. Style compilation converts `button[type]`, `button[type="primary"]`, and unqualified
's `[type]` selector maps to an internal projection that preserves the source attribute, maintaining the original selector specificity.
Omitting the WXML type will not add the source attribute out of thin air; the selectors of other native controls such as `input[type]` retain their original meaning.
Internal projections do not write back to ViewDocument or the event dataset, and applications cannot override it with a data attribute of the same name.

Basic color palette, size, border and focus styles using zero specificity `:where(...)` by WXSS
is loaded subsequently and the inline style priority remains intact. loading takes the CSS `::before` directive and respects it
`prefers-reduced-motion`; The author's pseudo-element styles can still override it. This default style is not an official resource or
Official pixel baseline.

<a id="验证范围"></a>
## Verification scope

Node contract covers basic properties and typed values, retains subtrees, explicitly unsupported, nested controls are rejected in advance,
disabled descendant blocking, loading interactive, capture/catch/ ownership, native type/ARIA projection,
Source type selector, default style priority, keyboard transfer strategy and updated focus restoration.

controls integration r6 has passed the real Enter/Space, disabled/loading, browser CSS/ layouts and
Special entry for late entry. Screen readers, devices, and official default behaviors are still subject to independent evidence acceptance; the implementation does not update frozen
279 release gates, nor does it grant Skia, other hosts, official equivalence or performance passes.

<a id="可选真实浏览器-fixture"></a>
## Optional real browser fixture

`browser-dev-loop-smoke.mjs` Added explicit `--fixture button`, only accepted
`--server-kind cli --renderer webview`. If not passed, the original reference fixture will continue to be used.
Will not treat historical button failures as passes. This mode still requires the caller to provide independent, fixed, and verified
`--server-bin`, `--producer-dir`, `--pins`, `--node-bin`, and a new `--out-dir`;
the runner does not build runtime, does not derive trust pin, and does not connect to existing preview or user Chrome.

The fixture uses real `button`/sub-node instances and the declared Page handler, public diagnostic module
reads only bounded event logs from the original AppService. It checks the first sub-node click and typed dataset, capture/catch,
native Enter/Space, disabled descendant blocking, loading interactions, actual computed CSS, and source type selector.
Dynamic checks use real touchstart to trigger disabled states, wait for the original `view.presented` final and current
DOM input fence, then send a late termination; requires the old touch point cancel to occur exactly once, with no late target/ancestors events,
and verifies that subsequent new touch interactions work normally. CDP for touch is only created by the runner's own context for its associated page,
and is detached in a dedicated finally block. No remote CDP or browser borrowing connections are used.

Space reconstruction is initiated by the actual button triggering the declared AppService timer; during hold of real Space, it waits for a new document,
binds the original owner if still input-capable, the current original final, the previously focused old iframe/document/element,
then requires the unique trusted Space keydown from this probe to originate from these still-connected old objects, and occur before
the new document's unique trusted focusin. The old iframe must be removed from the top-level document prior to this focusin;
the ownership and original `isConnected` of the old element and its Document are preserved respectively, and descendants detached from the top-level Document remain connected.
Missing the current keydown, input fence closure, or only finding prior ordinary Space records results in explicit failure;
late keyup is also checked to ensure it is not replayed, and new Space triggers only once. Observers install after capturing real iframe load from parent document,
without enabling scripts in sandboxed contexts. Module/DOM observation polling strictly awaits on the Node side;
it does not treat asynchronous browser expression Promises as fulfilled. All frame finals store only whitelisted metadata versions,
without recording any bridge payload or credentials.

Real compiler, WASM Worker, and browser-specific components have been fully integrated into `4f753cab`'s controls at r6,
passing 11 checks and completing 12 hot updates, build failures retained in interaction, and Stop cleanup. Execution results compared to previous failures are documented in
[Integration Evidence](../archived-evidence.en.md). These results are limited to
the tested environment; iframe removal from DOM and runtime touchcancel are observed release boundaries, and no claims are made regarding browser GC, hardware, or full memory leakage.
