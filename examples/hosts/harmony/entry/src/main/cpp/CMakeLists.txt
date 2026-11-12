cmake_minimum_required(VERSION 3.22.1)
project(weapp_container_harmony LANGUAGES C CXX)

add_library(entry SHARED native_bridge.cpp)
target_compile_features(entry PRIVATE cxx_std_17)
option(WEAPP_CONTAINER_RESTRICTED_SHOWCASE "Build the fixed showcase N-API adapter" OFF)
if(WEAPP_CONTAINER_RESTRICTED_SHOWCASE)
    # OHOS replaces CMAKE_SHARED_LINKER_FLAGS in its toolchain. Apply this to
    # the actual target after toolchain setup, including debug sections from
    # any SDK archive members selected by the final link.
    target_compile_options(entry PRIVATE -g0)
    target_link_options(entry PRIVATE -Wl,--strip-debug)
endif()
target_include_directories(entry PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
# The XComponent adapter owns an EGL window surface backed by the ArkUI
# surface id. Keep these platform libraries explicit so a HAP cannot compile
# while silently leaving the surface callbacks as a software-only stub.
target_link_libraries(entry PUBLIC
    libace_napi.z.so
    libace_ndk.z.so
    libnative_window.so
    libEGL.so
    libGLESv3.so
)

set(WEAPP_CONTAINER_HARMONY_RUST_LIB "" CACHE FILEPATH "Path to libcontainer_host_harmony.so")
# The repository build gate compiles the Rust cdylib into target/ before
# invoking Hvigor. Keep that deterministic local artifact discoverable while
# still allowing DevEco users and CI to override it with -DWEAPP_CONTAINER_HARMONY_RUST_LIB.
if(NOT WEAPP_CONTAINER_HARMONY_RUST_LIB)
    set(WEAPP_CONTAINER_HARMONY_RUST_LIB
        "${CMAKE_CURRENT_LIST_DIR}/../../../../../../../target/aarch64-unknown-linux-ohos/debug/libcontainer_host_harmony.so")
endif()
if(NOT EXISTS "${WEAPP_CONTAINER_HARMONY_RUST_LIB}")
    message(FATAL_ERROR "WEAPP_CONTAINER_HARMONY_RUST_LIB is required and must point to an existing Rust host library")
endif()
# Link by the library's soname instead of passing the absolute imported path.
# Rust's cdylib does not carry a SONAME by default; linking the full path makes
# lld encode the build machine path in libentry.so's DT_NEEDED entry, which
# cannot resolve after the HAP is installed.  A `-l:` item keeps the basename
# while the explicit link directory still validates the supplied artifact.
get_filename_component(WEAPP_CONTAINER_HARMONY_RUST_DIR "${WEAPP_CONTAINER_HARMONY_RUST_LIB}" DIRECTORY)
get_filename_component(WEAPP_CONTAINER_HARMONY_RUST_NAME "${WEAPP_CONTAINER_HARMONY_RUST_LIB}" NAME)
target_link_directories(entry PRIVATE "${WEAPP_CONTAINER_HARMONY_RUST_DIR}")
target_link_libraries(entry PRIVATE "-l:${WEAPP_CONTAINER_HARMONY_RUST_NAME}")
# A raw -l: item is not a file dependency in CMake's link graph. Track the
# supplied Rust artifact explicitly so an incremental Rust rebuild relinks
# entry and reruns its packaging step, including when the ABI is unchanged.
set_property(TARGET entry APPEND PROPERTY LINK_DEPENDS "${WEAPP_CONTAINER_HARMONY_RUST_LIB}")
# The Rust cdylib is copied next to libentry.so below.  CMake otherwise adds
# the absolute link directory to DT_RUNPATH, which leaks the developer's
# checkout path into the HAP and cannot work after installation.  Both native
# libraries are in the same HAP ABI directory, so the platform loader can
# resolve the basename in DT_NEEDED without a build-machine path.
set_target_properties(entry PROPERTIES
    SKIP_BUILD_RPATH TRUE
    SKIP_INSTALL_RPATH TRUE
)

# DevEco's native-library collector only packages files emitted in the CMake
# ABI output directory.  A raw `-l:` link item records the correct basename in
# DT_NEEDED but is not itself discoverable by ProcessLibs, so copy the exact
# Rust artifact next to libentry.so as a post-build output.  This keeps the
# Rust library independently built while making the HAP self-contained.
add_custom_command(TARGET entry POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "${WEAPP_CONTAINER_HARMONY_RUST_LIB}"
        "$<TARGET_FILE_DIR:entry>/libcontainer_host_harmony.so"
    VERBATIM
    COMMENT "Packaging libcontainer_host_harmony.so beside libentry.so"
)
