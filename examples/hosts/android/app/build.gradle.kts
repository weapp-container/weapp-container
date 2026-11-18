plugins {
    id("com.android.application")
    kotlin("android")
}

val rustJniLibsDir = layout.buildDirectory.dir("generated/rust-jni-libs")
val configuredRustLib = providers.gradleProperty("weappContainerAndroidRustLib")
    .orElse(providers.environmentVariable("WEAPP_CONTAINER_ANDROID_RUST_LIB"))

android {
    namespace = "com.sonofmagic.weapp.container"
    compileSdk = 36
    // Keep local APK smoke builds reproducible with the SDK image used by CI.
    // The native host still accepts an explicit NDK path from Gradle/CMake.
    buildToolsVersion = "36.0.0"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    defaultConfig {
        applicationId = "com.sonofmagic.weapp.container"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                val rustLib = providers.gradleProperty("weappContainerAndroidRustLib").orNull
                    ?: System.getenv("WEAPP_CONTAINER_ANDROID_RUST_LIB")
                arguments += "-DWEAPP_CONTAINER_ANDROID_RUST_LIB=${rustLib ?: ""}"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets["main"].jniLibs.srcDir(rustJniLibsDir)
}

// An imported CMake shared target is linked into libweapp_container.so, but AGP
// does not package that imported target automatically. Copy the exact Rust
// artifact into Gradle's generated jniLibs directory so Android's linker can
// resolve the SONAME at runtime without mutating the source tree.
val copyWeappContainerRustLib = tasks.register<Copy>("copyWeappContainerRustLib") {
    val rustLib = configuredRustLib.orNull?.takeIf { it.isNotBlank() }
        ?: throw GradleException("weappContainerAndroidRustLib or WEAPP_CONTAINER_ANDROID_RUST_LIB is required")
    from(file(rustLib))
    into(rustJniLibsDir.map { it.dir("arm64-v8a") })
    rename { "libcontainer_host_android.so" }
}

tasks.named("preBuild") {
    dependsOn(copyWeappContainerRustLib)
}

