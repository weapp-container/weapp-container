<a id="ios-交互固定装置"></a>
# iOS interaction fixture

[简体中文](README.md) · **English**


This mini-program is built by the pinned `weapp-vite` compiler and packed by
the normal container packer. The button occupies logical points `(0, 0, 200,
80)`. Its real page listener increments `count` and schedules a 100 ms JS
timeout; that timeout increments `timerCount`, then its Promise increments
`microtaskCount`. The fixture records App/Page foreground and resize hooks.

The official XCUITest runner taps `(40, 40)` relative to the native surface,
presses Home, activates the same process and rotates the device. Read-only
observation is enabled explicitly in the verification app build. It neither
invokes the session input APIs nor supplies fixture data from Swift.

This is local iOS simulator evidence. It does not establish official WeChat
equivalence, physical-device acceptance or seven-host parity.
