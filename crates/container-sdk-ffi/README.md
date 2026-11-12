# Weapp Container C ABI v1

The public contract is `sdk/contract/include/weapp_container_sdk.h`. The Rust crate
builds `weapp_container_sdk` as a static library, dynamic library, and Rust
library. Default features use the real QuickJS engine and Skia raster backend.
Android consumers add `quickjs-native-android,skia-gpu-gles`; iOS consumers add
`quickjs-native-ios,skia-gpu-metal`. macOS Metal uses `skia-gpu-metal`.
An explicit `--no-default-features` build is useful for ABI transport tests;
it is not a distributable renderer/engine implementation.

Session calls remain on the creating native thread. The API rejects foreign
threads before accessing runtime state. Platform wrappers should queue work
onto that owner thread and provide typed Kotlin, Swift, Dart, or TypeScript
APIs above the command boundary. An occupied output buffer is rejected before
executing a command. All result buffers must be released explicitly.

An acquired frame owns immutable premultiplied RGBA8 bytes independently of
the session. Retain/release permits the platform compositor to consume frames
on another thread, including after the session closes. Neither releasing a
frame nor reading its metadata invokes the runtime or a GPU context.

Detach the native surface before closing a session. After GLES context loss,
use `gles_abandon` on the owner thread instead of trying to delete resources
in a nonexistent context. Destroy accepts a pointer to the caller's handle
slot and clears it on success, allowing idempotent cleanup. A failure leaves
the slot intact. GPU entrypoints exist on every build and return a structured
unsupported error when their backend is not compiled.

`cargo test -p container-sdk-ffi --locked` runs transport/thread/frame tests
and compiles, dynamically links, and executes a real C consumer on Unix.
The C program references every public function, loads the checked-in Android
portable pack, acquires its rendered frame, and reads that frame after destroying
the session. A separate test compares the dynamic symbol table with the header,
so declaration/export drift cannot pass by parsing header text alone. Cross-platform release consumers
must additionally test the packaged static/dynamic library on their target.
