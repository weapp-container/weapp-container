cmake_minimum_required(VERSION 3.22.1)
project(weapp_container LANGUAGES C CXX)

add_library(weapp_container SHARED weapp_jni.cpp)
target_compile_features(weapp_container PRIVATE cxx_std_17)
target_include_directories(weapp_container PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_definitions(weapp_container PRIVATE WEAPP_CONTAINER_ANDROID_SKIA_GPU_GLES=1)

# The Rust cdylib is produced by scripts/build-native-hosts.mjs and copied into
# this directory before an Android Gradle build.  Keeping the location
# explicit prevents Gradle from silently selecting a stale architecture.
set(WEAPP_CONTAINER_ANDROID_RUST_LIB "" CACHE FILEPATH "Legacy arm64 path to libcontainer_host_android.so")
set(WEAPP_CONTAINER_ANDROID_RUST_LIB_ARM64 "" CACHE FILEPATH "arm64-v8a path to libcontainer_host_android.so")
set(WEAPP_CONTAINER_ANDROID_RUST_LIB_ARMV7 "" CACHE FILEPATH "armeabi-v7a path to libcontainer_host_android.so")
if(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(WEAPP_CONTAINER_ANDROID_RUST_LIB_SELECTED "${WEAPP_CONTAINER_ANDROID_RUST_LIB_ARMV7}")
else()
    set(WEAPP_CONTAINER_ANDROID_RUST_LIB_SELECTED "${WEAPP_CONTAINER_ANDROID_RUST_LIB_ARM64}")
    if(NOT WEAPP_CONTAINER_ANDROID_RUST_LIB_SELECTED)
        set(WEAPP_CONTAINER_ANDROID_RUST_LIB_SELECTED "${WEAPP_CONTAINER_ANDROID_RUST_LIB}")
    endif()
endif()
if(NOT WEAPP_CONTAINER_ANDROID_RUST_LIB_SELECTED)
    message(FATAL_ERROR "A Rust library for ${ANDROID_ABI} is required; run pnpm native:build first")
endif()
add_library(weapp_container_rust SHARED IMPORTED)
set_target_properties(weapp_container_rust PROPERTIES
    IMPORTED_LOCATION "${WEAPP_CONTAINER_ANDROID_RUST_LIB_SELECTED}"
    # Rust's cdylib has no SONAME by default.  Without an explicit imported
    # SONAME the linker records the developer's absolute checkout path in
    # DT_NEEDED and Android's linker cannot load the APK on a device.
    IMPORTED_SONAME "libcontainer_host_android.so"
    IMPORTED_NO_SONAME TRUE
)
# The JNI boundary uses C++ standard-library types and exception unwinding.
# Link the NDK runtime explicitly so the standalone native integration check
# and the Gradle APK build resolve the same runtime for QuickJS and V8.
target_link_libraries(weapp_container PRIVATE weapp_container_rust log android c++_shared)
