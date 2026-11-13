<a id="独立的-react-native-消费者"></a>
# Independent React Native consumer

[简体中文](README.md) · **English**


Prepare the example with `scripts/sdk-react-native-consumer.mjs --package /absolute/path/to/package.tgz --out /tmp/your-consumer`. It uses the official React Native 0.88 template, installs the exact npm archive, verifies its inventory, and includes the shared portable fixture. The public `App.tsx` exercises two native GPU sessions.

Run `scripts/sdk-react-native-smoke.mjs --consumer /tmp/your-consumer --platform ios|android --device EXISTING_DEVICE_ID --out FRESH_EVIDENCE_DIRECTORY`. Release is the default. `--development` uses real Metro Fast Refresh and a full React runtime reload. Android accepts `--refresh-rounds 1..20`.

On iOS Release, the default `--rotation device` uses XCTest device orientation. The separate `--rotation scene` enables a native consumer-only Rotate host button, calls UIKit scene geometry APIs, and checks both the real interface orientation/window dimensions and SDK surface resize events. It does not modify SDK viewport APIs or `App.tsx`, and a scene pass does not certify device-orientation injection. Both modes execute the complete lifecycle and durable reopen gates.

The runner preserves executed-test counts and attachments on failure, removes its apps and runner, restores temporary source changes, and closes its owned Metro process. It never shuts down the borrowed device.

Export a portable example with `scripts/sdk-react-native-example.mjs --consumer /tmp/your-consumer --out /directory/beside/the/tgz/example --rotation device|scene`. Export verifies an offline `npm ci`, removes its installed dependencies, and records the exact archive and fixture hashes.

`host/` is the separate native-stack, parent ScrollView and touch-cancellation harness.
