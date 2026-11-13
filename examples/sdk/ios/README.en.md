<a id="独立的-uikit-消费者"></a>
# Independent UIKit consumer

[简体中文](README.md) · **English**


The smoke runner copies the prepared Swift package and shared portable fixture into a new consumer directory. It compiles the device arm64 and simulator x86_64 targets, then runs one XCTest on an existing borrowed arm64 simulator. It never creates or shuts down a simulator.

```sh
node scripts/sdk-ios-smoke.mjs \
  --distribution /absolute/path/to/WeappContainer \
  --simulator EXISTING_SIMULATOR_UDID \
  --out artifacts/sdk/ios/validation
```

The default `--rotation device` uses `XCUIDevice.orientation`. `--rotation scene` separately exercises the host's Rotate button, `setNeedsUpdateOfSupportedInterfaceOrientations()` and `UIWindowScene.requestGeometryUpdate`. Both modes require the actual interface orientation and native surface dimensions to change and return to portrait. A scene-mode pass does not certify device-orientation injection; each receipt records its mode.

Both modes retain the same dual-session, asynchronous host-call, native touch/scroll, navigation, background, persistent reopen, parent/embedded scrolling and multitouch gates. `--compile-only` validates device and x86_64 compile/link without using a simulator; `--simulator-only` builds and runs only the arm64 simulator consumer, skipping the other two architecture checks.

SwiftPM and CocoaPods runners copy the same `Sources/Consumer.swift`. Both session observers explicitly handle every public event, including native chrome, close errors and versioned raw events. Raw events are retained in a bounded history. Account-switch observations record the receipt and current SDK state, discard prior-owner geometry while input is blocked, and expose failures; SDK cancellation, cleanup and surface rebinding remain owned by the SDK. Recording these events does not certify an account switch or host-service flow: the current smoke test does not configure account or payment services.

Receipts include the distribution inventory digest, executable and consumer/test source hashes, executed-test counts, and verified app cleanup. If XCTest fails, the runner preserves `last-consumer-result.json` before removing its app and runner. Screenshots and the xcresult remain alongside the receipt.

The generated project also provides a Release archive configuration. From an exported consumer, run `xcodebuild -project SDKConsumer.xcodeproj -scheme SDKConsumer -configuration Release -sdk iphoneos -destination generic/platform=iOS -archivePath /absolute/path/SDKConsumer.xcarchive CODE_SIGNING_ALLOWED=NO archive` for an unsigned archive. Distribution signing and real-device execution are separate steps.
