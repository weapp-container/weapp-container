plugins {
    id("com.android.application")
    kotlin("android")
}

val rustJniLibsDir = layout.buildDirectory.dir("generated/rust-jni-libs")
val configuredRustLib = providers.gradleProperty("weappContainerAndroidRustLib")
    .orElse(providers.environmentVariable("WEAPP_CONTAINER_ANDROID_RUST_LIB"))
val configuredRustLibArm64 = providers.gradleProperty("weappContainerAndroidRustLibArm64")
    .orElse(providers.environmentVariable("WEAPP_CONTAINER_ANDROID_RUST_LIB_ARM64"))
val configuredRustLibArmv7 = providers.gradleProperty("weappContainerAndroidRustLibArmv7")
    .orElse(providers.environmentVariable("WEAPP_CONTAINER_ANDROID_RUST_LIB_ARMV7"))
val configuredEngine = providers.gradleProperty("weappContainerEngine").orElse("quickjs")
    .get().lowercase()
require(configuredEngine == "quickjs" || configuredEngine == "v8") {
    "weappContainerEngine must be quickjs or v8"
}
val rustLibArm64 = (configuredRustLibArm64.orNull ?: configuredRustLib.orNull)?.takeIf { it.isNotBlank() }
val rustLibArmv7 = configuredRustLibArmv7.orNull?.takeIf { it.isNotBlank() }
val configuredAbis = buildList {
    if (rustLibArm64 != null) add("arm64-v8a")
    if (rustLibArmv7 != null) add("armeabi-v7a")
}

android {
    namespace = "com.sonofmagic.weapp.container"
    compileSdk = 36
    // Keep local APK smoke builds reproducible with the SDK image used by CI.
    // The native host still accepts an explicit NDK path from Gradle/CMake.
    buildToolsVersion = "36.0.0"
    ndkVersion = "27.1.12297006"

    buildFeatures {
        buildConfig = true
    }

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
        buildConfigField("String", "WEAPP_CONTAINER_ENGINE", "\"$configuredEngine\"")

        ndk {
            abiFilters += configuredAbis.ifEmpty { listOf("arm64-v8a") }
        }

        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                val rustLib = providers.gradleProperty("weappContainerAndroidRustLib").orNull
                    ?: System.getenv("WEAPP_CONTAINER_ANDROID_RUST_LIB")
                arguments += "-DWEAPP_CONTAINER_ANDROID_RUST_LIB=${rustLib ?: ""}"
                arguments += "-DWEAPP_CONTAINER_ANDROID_RUST_LIB_ARM64=${configuredRustLibArm64.orNull ?: rustLib ?: ""}"
                arguments += "-DWEAPP_CONTAINER_ANDROID_RUST_LIB_ARMV7=${configuredRustLibArmv7.orNull ?: ""}"
                arguments += "-DWEAPP_CONTAINER_ANDROID_JNI_LIBS_DIR=${rustJniLibsDir.get().asFile.absolutePath}"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    packaging {
        jniLibs.keepDebugSymbols += setOf("**/libc++_shared.so")
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets["main"].jniLibs.srcDir(rustJniLibsDir)
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
}

// An imported CMake shared target is linked into libweapp_container.so, but AGP
// does not package that imported target automatically. Copy the exact Rust
// artifact into Gradle's generated jniLibs directory so Android's linker can
// resolve the SONAME at runtime without mutating the source tree.
val copyWeappContainerRustLibArm64 = rustLibArm64?.let { rustLib ->
    tasks.register<Copy>("copyWeappContainerRustLibArm64") {
        from(file(rustLib))
        into(rustJniLibsDir.map { it.dir("arm64-v8a") })
        rename { "libcontainer_host_android.so" }
    }
}

val copyWeappContainerRustLibArmv7 = rustLibArmv7?.let { rustLib ->
    tasks.register<Copy>("copyWeappContainerRustLibArmv7") {
        from(file(rustLib))
        into(rustJniLibsDir.map { it.dir("armeabi-v7a") })
        rename { "libcontainer_host_android.so" }
    }
}

tasks.named("preBuild") {
    copyWeappContainerRustLibArm64?.let { dependsOn(it) }
    copyWeappContainerRustLibArmv7?.let { dependsOn(it) }
    if (copyWeappContainerRustLibArm64 == null && copyWeappContainerRustLibArmv7 == null) {
        throw GradleException("at least one Android Rust library path is required")
    }
}

