#include "weapp_container_ios_ffi.h"

/*
 * These declarations are resolved by the Rust staticlib when an application
 * links WeappContainerHost.  Keeping the C target tiny makes `swift build`
 * useful as a local ABI check while avoiding a second JSON implementation.
 */
