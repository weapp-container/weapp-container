<a id="dom-inputtextarea-基础适配"></a>
# DOM input/textarea basic adaptation

[简体中文](dom-text-controls.md) · **English**


DOM presenter maps `input`, `textarea` in evaluated `ViewDocument` to real HTML text controls. The remote DOM and Browser QuickJS Worker DOM share the same adapter; application logic, event declarations, and component/slot ownership are still managed by the existing runtime, and applet scripts are not executed in iframes.

This page defines the basic state and event contract of text editing. It does not mean that native Chinese IME sessions are continuously preserved across document reconstructions, nor does it grant WeChat official, seven-host, accessibility, device, or performance gate passes.

<a id="属性与内容"></a>
## Attributes and content

| Properties/Content | Basic Behavior |
| --------- | -------- |
| `input` | Real single-line HTML input; supports `text` and `password`, password flag selects native password display |
| `textarea` | Real multi-line HTML textarea; content is set by `value` attribute, template child nodes are not used as initial values |
| `value`, `placeholder` | Use typed attribute-first scalar projection; objects and arrays are explicitly rejected |
| `disabled` | Set the true native disabled and block the interaction of the disabled control at the local and runtime input boundaries |
| `maxlength` | Explicit values are verified first and then applied; `-1` lifts the length limit and does not hand over illegal values to the browser for implicit truncation or conversion |
| `cursor`, `selection-start`, `selection-end` | Accepts `-1` or a non-negative signed 32-bit integer; `-1`/Omitted indicates no explicit request, illegal values explicitly fail |
| `id/class/style/hidden/data-*/aria-*/role/tabindex` | Reuse existing DOM attributes, declaration ownership, and WXSS boundaries; internal `data-wc-*` is not open to applications |

When `maxlength` is not specified, the browser's native default value is retained, and the default length of the official applet is not overwritten.
Explicit length checksums with the UTF-16 selection offset are the current base contract and have not been proven to be equivalent to the full character count, input method, and truncation rules of the fixed base library. Declarative `focus` values ​​that request focus are still explicitly denied, and controls that have not yet been granted rendering authorization cannot be focused ahead of time by preparing candidates or setting properties.

Input/textarea does not accept child nodes; text controls within buttons, including descendants wrapped by custom components, are rejected in full document preflight. Unknown input types, unconnected native keyboard/host properties, and unsupported combinations return explicit errors and do not generate behaviorless placeholder controls. This adaptation does not change Skia or other host capability declarations.

<a id="编辑状态与候选事务"></a>
## Edit status and candidate transactions

Each accepted candidate saves the local value, scroll position, focus, selection area start and end, and direction by occurrence.
The snapshot also carries the semantic identity of the control: tag, input type, declaration document and component/event/slot ownership.
Only occurrence names in the same session and the same page have the same name, and the editing status cannot be transferred to different declared owners or controls of different types based on this.

When the identity matches and the normalized declaration of `value` is unchanged, the new candidate can retain the user's local edits that have not been written back to AppService. The declaration `value` uses the new declaration value when explicitly changed.
`selection-start`/`selection-end` must be given non-negative values ​​at the same time, and the starting point is not greater than the end point; the explicit selection area takes precedence over `cursor`. When there is no explicit request and the identity matches, restore the snapshot selection area and direction.
All selection areas are clamped to the UTF-16 length of the final actual value. New disabled controls cannot regain focus.
Restore the actual value first and then resume scrolling to avoid the browser clamping the offset according to the old short declared value; the scroll snapshot is also subject to the semantic identity of the text control and cannot be transferred to a new owner of the same occurrence or a different type.

Prepare, commit and final ACK continue to use existing `PresentationKey`, epoch and input authorization.
Internal recovery focus is not reported as a new user focus/blur to avoid `bindfocus → setData → 重建 → 恢复焦点` repeatedly triggering business processing. Real user focus changes still enter the batch event stream, and possible geometry changes after recovery are reported through the existing geometry path.

Failed candidates will not be granted input; whether old candidates can continue to interact is determined by the original rendering transaction and the valid version of the runtime.
Keeping the old screen does not mean that the old key, page or owner can still be entered. Retirement, disconnection, and page switching will continue to revoke corresponding permissions and resources, and expired sessions will not be restored by copying and editing snapshots.

<a id="输入与键盘事件"></a>
## Input and keyboard events

Native input, focus, blur and single-line confirm collect `value`, `cursor`, `selectionStart`, `selectionEnd` and other text facts, and pass them to the runtime through the existing batch `view.events`.
The browser does not provide a handler, component owner, propagation path, or dataset authority; the runtime redispatches from the declared topology of the currently accepted document.

Each edit event's `value` has a separate **64 KiB UTF-8** transfer budget; it is not equal to the character count of the native `maxlength`, nor does it silently truncate input. The runtime explicitly rejects overrun, unknown text field, invalid UTF-16 offset, and disabled control events, and validates the entire batch of input before executing any of the callbacks.
Password fields with no listeners declared do not send text values; geometry observations do not contain edit content.

Single-line Enter will only generate confirm in the non-input method combination stage. `isComposing` or compatible keyCode 229 Input method keyboard events cannot be submitted as confirmations. By default, textarea Enter is inserted into a newline by the browser, and the confirm synthesis of a single-line input is not reused. The composition status is only used for local keyboard determination. This time, the composition field is not added to the wire protocol.

Use the return string of the input handler to replace the native value, the complete non-bubbling rules for official focus/blur/input and other events, and the platform-specific confirm/keyboard behavior. The official semantic comparison has not yet been completed.
The boundaries of event routing capture/destination/bubble/catch are not automatically upgraded by this foundational adaptation.

<a id="原生-ime-的明确限制"></a>
## Clear Limitations of Native IME

The current ordinary rendering follows the pattern: "old iframe snapshot → create new iframe → restore state → ACK".
Native IME composition inherently resides within the actual Document and text control. Operations such as copying value, selecting text range, or manipulating composition flags cannot replicate the browser's native input method session. As a result, while this implementation can detect Enter events during composition, it cannot guarantee continuity of Chinese input method behavior during unrelated setData operations, hot updates, or candidate replacement phases.

A full implementation requires coordination with stable, document-attached controls, or an independent and stable native editing surface/lease. Ordinary data updates should preserve the actual editing control, and editing must be explicitly terminated when the page, semantic identity, or authorization fails. After the runtime revokes the old rendering's privileges, waiting for a compositionend from the old control does not substitute for the lifecycle design of editing.

Future [Native Editing Continuity Design](native-editing-continuity.en.md) will define Document, document permit, final geometric acceptance, and limited editing lease as separate entities. This document represents a proposed protocol that is not yet implemented and does not imply current v1 support for cross-rendering IME, nor does it extend any capabilities already declared.

<a id="验证与证据"></a>
## Verification and Evidence

Required validation includes real input, single-line/multi-line Enter, input method confirmation filtering, selection range and navigation, declared value coverage, local editing retention, disabled states, semantic identity changes, non-repeating focus restoration callbacks, failed candidate handling, and rejection of input from legacy rendering. Testing involving Page handler, setData, and rendering version checks must be executed in actual runtime environments—synthetic ViewDocument or DOM doubles are insufficient substitutes.

Source code, environment, and results from each execution are independently archived and documented; this page does not claim test success. Synthetic composition events can only validate local filtering logic and do not prove the continuity of operating system-level Chinese input methods, native session integrity, or hardware device behavior. The 279-item release gatekeeping remains frozen with its original acceptance criteria.
