# Public SDK Release Status

[简体中文](public-sdk-release.md) · **English**

Checked on 2026-11-25. Every currently visible release is a prerelease. There is no stable version. Source availability, anonymous registry downloads, successful builds, and device acceptance are separate states.

| SDK / artifact | `0.1.0-preview.7.1` status | Current limitation |
| --- | --- | --- |
| Core runtime | GitHub prerelease `runtime-v0.1.0-preview.7.1` is anonymously downloadable | Prerelease only |
| DevTools | GitHub prerelease `devtools-v0.1.0-preview.7.2` is anonymously downloadable | macOS and Windows packages are unsigned; prerelease only |
| Android | Maven Central coordinate `io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1` resolves | Prerelease only |
| React Native | npm package `@weapp-container/react-native@0.1.0-preview.7.1` installs, and its Android dependency resolves | The pinned iOS native archive URL is unavailable |
| Flutter | All seven hosted `.7.1` packages are published on pub.dev | Native builds still require platform-specific verification |
| iOS | The core prerelease contains an iOS SDK tarball | The pinned SwiftPM and CocoaPods archive URLs in `sdk-ios` return 404; its GitHub release does not exist |
| Desktop | The core prerelease contains macOS, Linux, and Windows SDK tarballs | The standalone `sdk-desktop` GitHub release does not exist; the macOS archive URL in the public CocoaPods Specs returns 404 |

The available prerelease installation entries are:

```kotlin
implementation("io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1")
```

```sh
npm install @weapp-container/react-native@0.1.0-preview.7.1
```

```yaml
dependencies:
  weapp_container: 0.1.0-preview.7.1
```

Android, Flutter, and React Native package versions were checked through anonymous Maven Central, pub.dev, and npm metadata requests. The iOS and Desktop status also checks their GitHub releases, CocoaPods Specs, and pinned archive URLs. No `WeappContainer` or `WeappContainerDesktop` entry was found on CocoaPods Trunk.

## Example Applications

Each SDK example uses a portable fixture with a matching runtime version. Review the platform requirements and release limitations in its SDK README, then follow the example directory's commands to create the fixture, build the application, and launch a device or simulator.

- [Android reference app](../sdk/android/consumer/README.en.md)
- [iOS UIKit consumer](../sdk/ios/examples/consumer/README.en.md)
- [React Native consumer](../sdk/react-native/example/README.en.md)
- [Flutter consumer](../sdk/flutter/example/README.en.md)
- [Desktop consumer](../sdk/desktop/consumer/README.en.md)

## Release Channels

The release tools select a channel from the SDK semantic version. `X.Y.Z` creates a GitHub stable release and marks it latest. Versions with a prerelease identifier create GitHub prereleases. npm packages use the `latest` and `preview` dist-tags respectively. Maven Central, CocoaPods, and pub.dev continue to publish immutable version numbers. The currently public versions remain the prereleases listed above, and no stable installation coordinates have been produced.

## Maintainer Credentials

### macOS DevTools signing and notarization

Have an organization administrator enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/). In **Certificates, Identifiers & Profiles**, create a **Developer ID Application** certificate, generate its CSR in Keychain Access, download the certificate, and install it on the signing Mac. Export the certificate and matching private key together as a password-protected `.p12`. Set `WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY` to the full identity printed by `security find-identity -v -p codesigning`.

In App Store Connect, open **Users and Access > Integrations > App Store Connect API**, create a **Team API key**, download its `.p8`, and record the Key ID and Issuer ID. Apple only makes the `.p8` available once, so create an encrypted backup immediately. This key authenticates notarization and is separate from the Developer ID certificate.

### Windows DevTools signing

Obtain an Authenticode code-signing certificate from a publicly trusted CA and complete its organization identity checks. Before ordering, confirm that the private key can be exported as a `.pfx` containing the private key. The current workflow imports that PFX on an ephemeral Windows runner. A certificate usable only through a hardware token or cloud-signing service requires a matching workflow integration first.

### SDK registry credentials

- **Maven Central (`sdk-android`)**: Verify the `io.github.weapp-container` namespace in Central Portal, then generate a **User Token** from account settings. Set its username and password as `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`. These are CI credentials, not the Portal login password. Generate an OpenPGP key with GnuPG that supports detached signing, publish its public key to a public keyserver, and set the ASCII-armored private key as `WEAPP_SIGNING_KEY`. Set `WEAPP_SIGNING_PASSWORD` when that private key has a passphrase. The Android workflow reads these Actions secrets in the `sdk-android` repository.
- **Historical private runtime archives**: `WEAPP_CONTAINER_RUNTIME_TOKEN` is required only when a manifest selects a frozen historical version. Ask a repository maintainer to grant access to `weapp-container/runtime-artifacts-private-archive`, then create a fine-grained GitHub token with **Contents: read** access to that repository and inject it through the environment. The current preview.7.1 and source-build paths do not require this token.
- **CocoaPods (`sdk-ios`, `sdk-desktop`)**: Install CocoaPods and run `pod trunk register maintainer@example.com "Maintainer Name"`, then follow the verification email. Trunk stores its account token in the `trunk.cocoapods.org` entry in `~/.netrc`. Set that token as the `COCOAPODS_TRUNK_TOKEN` secret in both repositories. The account that publishes a Pod becomes its owner and manages later maintainers.
- **npm (`sdk-contract`, `sdk-react-native`)**: The publisher needs permission for the relevant `@weapp-container` package. A maintainer manually publishes a new package after logging into npm and completing 2FA. Once the package exists, configure a trusted publisher in its npm settings for the exact GitHub repository and `publish-npm.yml` workflow. The workflows use OIDC, so later releases need no long-lived npm token.
- **pub.dev (`sdk-flutter`)**: The publisher needs release access to all seven packages. Configure a GitHub trusted publisher on each existing package's pub.dev admin page, targeting `weapp-container/sdk-flutter`. The publication workflow uses OIDC and needs no pub.dev token in GitHub. A new package still needs an owner to make its first manual publication before setting up its trusted publisher.

To create the Maven signing key, generate it locally and export it to a protected directory outside the repository, then publish its public key to a public keyserver:

```sh
gpg --full-generate-key
gpg --list-secret-keys --keyid-format LONG
umask 077
gpg --armor --export-secret-keys YOUR_KEY_ID > /secure/path/weapp-signing-private.asc
gpg --armor --export YOUR_KEY_ID > /secure/path/weapp-signing-public.asc
gpg --keyserver hkps://keys.openpgp.org --send-keys YOUR_KEY_ID
```

Replace `YOUR_KEY_ID` with the generated key ID and `/secure/path` with a directory readable only by the maintainer. Store the private file contents as the `WEAPP_SIGNING_KEY` secret.

### DevTools update key

The DevTools update manifest uses an Ed25519 key pair generated by the maintainer. No certificate authority issues it. Run this Node.js 24 command from a protected directory outside the repository:

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync('weapp-devtools-update-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync('weapp-devtools-update-public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
NODE
```

Keep an encrypted backup and use the same key pair throughout the stable update lifecycle. Set the private PEM as the core repository secret `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY` and the public PEM as the repository variable `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY`. New DevTools clients embed that public key to verify updates. Losing the private key prevents future updates from being trusted by already released clients.

### GitHub configuration

Add secrets under each repository's **Settings > Secrets and variables > Actions**. Add the public update key as a repository variable. Set the Base64 contents of `.p12`, `.p8`, and `.pfx` as `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_BASE64`, `WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_BASE64`, and `WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_BASE64`, respectively. Put the certificate export passwords in their matching `*_PASSWORD` secrets, the Mac identity in `WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY`, and the API Key ID and Issuer ID in their matching secrets. Generate a separate strong password for `WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD` and keep it in a password manager. Encode files as single-line Base64 values. The workflow restores them on ephemeral runners. Never commit certificates, `.netrc`, GPG private keys, or key files.

The core repository requires DevTools secrets `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_BASE64`, `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_PASSWORD`, `WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD`, `WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY`, `WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_BASE64`, `WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_ID`, `WEAPP_DEVTOOLS_MACOS_NOTARY_ISSUER`, `WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_BASE64`, `WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_PASSWORD`, and `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY`, plus the variable `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY`. Android Maven secrets are configured. npm and pub.dev workflows use GitHub OIDC and need no long-lived publication token.

Application guides: [Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/), [App Store Connect API keys](https://developer.apple.com/help/app-store-connect/manage-keys/create-api-keys-for-app-store-connect-api/), [Sonatype Central user tokens](https://central.sonatype.org/publish/generate-portal-token/), [GnuPG key management](https://www.gnupg.org/documentation/manuals/gnupg/OpenPGP-Key-Management.html), [npm trusted publishers](https://docs.npmjs.com/trusted-publishers), [pub.dev automated publishing](https://dart.dev/tools/pub/automated-publishing), [CocoaPods Trunk setup](https://guides.cocoapods.org/making/getting-setup-with-trunk.html), and [GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-for-github-actions).

## Stable Release Requirements

A stable release needs a distinct stable version, immutable installation archives for each SDK, anonymous installation-consumer verification, and target-platform build records for each package manager. `.7.1` is a prerelease and cannot be recorded as stable. The iOS and Desktop GitHub archives are unpublished, so SPM, CocoaPods, and React Native iOS paths that reference those archives cannot be reported as available.
