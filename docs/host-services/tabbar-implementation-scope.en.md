<a id="动态系统-tabbar-的实现范围"></a>
# Scope of Implementation for Dynamic System TabBar

[简体中文](tabbar-implementation-scope.md) · **English**


Fixed baseline at WeChat Foundation Library 3.17.3, `miniprogram-api-typings@5.2.3`, 1265 API × seven platforms = 8855 units. This batch implements five real-time runtime transactions and installed consumption chains: `setTabBarBadge`, `removeTabBarBadge`, `showTabBarRedDot`, `hideTabBarRedDot`, `setTabBarStyle`. They are marked as partial in the specific Player chains of Android, iOS, macOS, Windows, Linux, totaling 25 missing→partial; no new available or accepted entries.

<a id="状态与调用边界"></a>
## State and Call Boundary

Two engines share a TabBar facade. It only reads the raw field data from the parameter object itself, rejects accessors and error types, and does not execute `toJSON()` on fields or callbacks during JSON serialization. The original callback enters the existing asynchronous settlement chain as a non-enumerable property; failure retains the callback, complete, and Promise settlement path. This fix is limited to this API boundary and does not claim that a general bridge supports arbitrary JavaScript objects.

Session holds validated styles and indicator states. Native processing revalidates lifecycle, effective capability, internal transport deadline/cancel, current page, non-custom configured tabBar, and real index prior to mutation. Styles are first validated as a whole before submission; colors are uniformly represented as six-digit hex. Badges display `...` when UTF-16 length exceeds four; NUL text is explicitly rejected. Badges and red dots are currently mutually exclusive, with removal only clearing the corresponding indicator. These Unicode and interaction rules still require a real oracle from the WeChat version runtime and are not considered complete semantic declarations.

State is retained according to normal push/pop/switch operations and is cleared when the session terminates. It projects to the existing chrome; the SDK independently detects chrome metadata revision, thus no layout or frame update forgery is required. After receiving new metadata, Android/iOS/macOS uses Flutter for rendering, while Windows/Linux uses Flutter native desktop registry, NativePreviewTexture, and consumes the installed Windows/Gtk overlay. Changes in styling or indicators under the same geometry are also propagated to the native overlay.

<a id="默认拒绝与真实-presenter"></a>
## Default Denial and Real Presenter

Trusted host configuration `systemTabBar` defaults to false, false is not written to old JSON configuration. Only hosts with installed consumption chain should pass true; event forwarding or SDK configuration fields themselves do not indicate presenter. Rust SDK, Android/iOS SDK, desktop, and Flutter paired versions pass this field, Player explicitly opts in.

Default pack request five Partial, to prevent the actual default CLI output from being rejected by manifest omissions even after SDK opt-in. manifest, host config, and provider still use the minimum supported level, with a final cap of Partial; explicit lowering of manifest remains valid. The packer's independent default host diagnostic matrix remains Unsupported, and it does not participate in runtime admission.

Built-in Web/Harmony entry points have no opt-in and remain Unsupported/missing. Trusted low-level `SessionConfig.capabilities` can explicitly permit Partial; there is no unconditional rejection of all explicitly configured rules based on HostKind. The effective capability for `tabBar.custom:true` and actual calls are both Unsupported. Calls without configured tabBar are also rejected, but the capability table itself does not serve as an oracle for app configuration completeness.

`showTabBar`、`hideTabBar`、`setTabBarItem` are still missing/Unsupported across all seven endpoints, even if the manifest/config declares Full support. Capabilities such as visibility, animations, remote or temporary icons are not completed and will not be promoted in this batch.

<a id="验证与未闭合范围"></a>
## Verification and Uncommitted Scope

The final product `61013a7db713e5dac46a89b57a67b53bdf16b4ba` has passed all 38 freeze stages along with complete source code/tool bindings before and after. Full [evidence](../archived-evidence.en.md) retains original commands, logs, and failures. Freeze validation executed 6 unit, 7 integration, and 3 SDK use cases based on real QuickJS/V8, covering default CLI pack, false/true/custom admission, original callback, no hook execution, transaction atomicity, lifecycle, and internal cancellation/timeout. Internal transport fields are not declared as public TabBar parameters. All 140 packer, 351 Node in six files, 30 public contracts/real TypeScript, 244 Player, and 132 installed Flutter SDKs passed; Player analyzer, three modified Player Dart file formats, and modified Rust formats along with whitespace across repositories passed. workspace 2716 passed/9 ignored, native engines 557/2, runtime 640/0, boundaries 170/1, and 117 matrix IO and 14 host-service gateways passed; overlapping test cases across commands are not aggregated into a unique test total.

Portable C++17 palette helper and injection registry are actually compiled and executed, Swift 6 performs semantic checks on Types, and Session/plugin performs parse. The Windows/Gtk rendering branch is not compiled or executed natively; the portability of the helper does not imply these branches have passed. Android/Kotlin build environment is missing; standalone iOS lacks native XCFramework and full linking is not completed. Flutter widget tests do not represent native OS pixels or device execution.

The first product `a82fc73e` has 34 frozen stages with only host-services failing: the updated SDK wrapper/README has not been synchronized with the existing `SOURCE-INVENTORY.json`, and the strict archiving guard correctly rejects. Four existing manifests have been regenerated, validated, and pushed to the SDK work branch via independent submissions; the contract does not include this manifest and does not introduce any bypass formats. The historical `ORIGIN.json` and implementation files are preserved byte-for-byte. Host service validation now aggregates pre-checks of the four manifests; if any check fails, subsequent compilation is skipped; the input manifest simultaneously overrides the actual source code, manifests, and tools for the four SDKs, and runtime modifications also result in failure. Both the original failure and the new freeze after fix are preserved. Independent Web producer, direct/Worker release builds for a new target, strict archiving, and empty directory installation pass independently; the existing reference portable fixture does not imply a new default TabBar package or browser acceptance, and Worker product assets remain disabled. 2988 gzip evidence payloads are copied to the repository and then individually verified against raw/gzip hashes.

Five areas still lack a complete lock contract, full public SDK presenter chain, and actual runtime/pixel evidence from the platform. callback/Promisify returns, precise Unicode/emoji dot interactions, error and visual/accessibility parity, and independent native and mobile React Native consumption chains remain to be closed; no new red dot accessibility state announcements have been issued. Linux scope covers installed X11/Gtk paths, retaining Wayland admission restrictions. No public SDK, device, WeChat oracle, or merchant acceptance has been disclosed, and no production release has occurred.

Current total is available 1412 (15.95%) / partial 1001 / requiresHostService 86 / missing 6356; accepted 0, platformNotApplicable 87. 80% target still 7084 available, short by 5672; stage goal still not completed, parent full acceptance goal remains paused and not completed.
