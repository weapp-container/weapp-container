plugins {
    id("com.android.application") version "8.13.2"
    kotlin("android") version "2.0.21"
}

val pack = file(providers.gradleProperty("portablePack").get())
val stagedAssets = layout.buildDirectory.dir("vendor-assets")
val stagePack by tasks.registering(Sync::class) {
    doFirst { require(pack.resolve("manifest.json").isFile) { "Pass a portable pack with -PportablePack" } }
    from(pack) { into("portable-pack") }
    into(stagedAssets)
}

android {
    namespace = "dev.weapp.vendor"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.weapp.vendor"
        minSdk = 26
        targetSdk = 34
    }
    sourceSets.getByName("main").assets.srcDir(stagedAssets)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

tasks.named("preBuild") { dependsOn(stagePack) }
dependencies { implementation("io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1") }
