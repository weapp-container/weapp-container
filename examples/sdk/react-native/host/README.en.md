<a id="本地宿主集成验收"></a>
# Native host integration acceptance

[简体中文](README.md) · **English**


This harness is separate from the distributable example. It installs the exact npm archive, verifies every SDK file against its inventory, and adds pinned React Navigation native-stack dependencies only to a new independent consumer. It does not change SDK code or the main example.

```sh
node scripts/sdk-react-native-host-consumer.mjs --package PATH_TO_SDK.tgz --out /tmp/weapp-rn-host-consumer
node scripts/sdk-react-native-host-smoke.mjs --consumer /tmp/weapp-rn-host-consumer --platform ios --device EXISTING_SIMULATOR_ID --out /tmp/rn-host-ios-evidence
node scripts/sdk-react-native-host-smoke.mjs --consumer /tmp/weapp-rn-host-consumer --platform android --device EXISTING_EMULATOR_ID --out /tmp/rn-host-android-evidence
```

The app keeps its controller above a native host navigation stack and embeds its native surface inside a React Native `ScrollView`. Tests exercise actual host push/pop while preserving the mini-program's own page stack and state, drag the parent area and the embedded scroll area separately, and push a host route while a finger remains down. The last case requires a native `touchcancel`, no accidental tap, and a successful fresh touch after returning.

The fixture extends the shared acceptance pack with touch-event observations. Its distinct content hash is recorded in the receipt. iOS runs three XCTest methods and exports per-test JSON and screenshots. Android drives the installed release APK using device input and records its receipt, screenshot and app-process log. A build alone is not a passing device test. iOS can select one method with `--test testHostRoute`, `--test testNestedScroll`, or `--test testTouchCancellationOnHostPush` while diagnosing a failure.

Use a fresh evidence directory for each run. The runner uninstalls only its own app and XCTest runner and preserves the borrowed device. Never run it concurrently with another task's device interaction.
