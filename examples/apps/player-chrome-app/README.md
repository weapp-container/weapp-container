# Dev Player chrome fixture

```sh
pnpm simulator:dev -- --project examples/apps/player-chrome-app --surface devices
```

Connect a preview.4 Player using the one-time device link. This app exercises
normal/custom navigation, dynamic title/color, host tabBar, capsule geometry,
page back, and persistent storage across capsule close/reopen.

Opening tools preserves the count; navigating back preserves the home count;
closing/reopening resets page memory but retains saved storage. Rotate and check
that reported capsule coordinates match the actual capsule in logical screen pixels.
The original WeChat output remains usable in official developer tools.
