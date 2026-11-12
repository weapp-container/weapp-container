import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.LibraryAndroidComponentsExtension

plugins {
    id("com.android.application") apply false
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// An explicit toolchain selection covers the whole native dependency closure.
// Library plugins can set flutter.ndkVersion in their own DSL; finalizeDsl
// applies the requested version after that configuration without editing them.
providers.gradleProperty("weappContainerNdkVersion").orNull?.let { selectedNdk ->
    require(Regex("[1-9][0-9]*\\.(0|[1-9][0-9]*)\\.[1-9][0-9]*").matches(selectedNdk)) {
        "weappContainerNdkVersion requires an exact major.minor.build version"
    }
    subprojects {
        plugins.withId("com.android.application") {
            extensions.getByType<ApplicationAndroidComponentsExtension>().finalizeDsl {
                it.ndkVersion = selectedNdk
            }
        }
        plugins.withId("com.android.library") {
            extensions.getByType<LibraryAndroidComponentsExtension>().finalizeDsl {
                it.ndkVersion = selectedNdk
            }
        }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
