plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Building llama.cpp for arm64 takes about fifteen minutes and needs the NDK.
// The JVM unit tests touch none of it, so `-Pfleet.skipNative` drops the whole
// native toolchain from the build — which is what lets CI run the tests on a
// plain runner in a couple of minutes instead of installing an NDK to compile
// code the tests never call.
//
// It is a testing flag, not a build flavour. An APK produced with it loads no
// llama.cpp and would report no LLM numbers at all, so nothing that packages a
// runner should ever pass it.
val skipNative = providers.gradleProperty("fleet.skipNative").isPresent

android {
    namespace = "com.taylab.fleetrunner"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.taylab.fleetrunner"
        // Old devices are the point of the fleet: keep minSdk as low as the
        // HTTP + foreground-service core allows. llama.cpp will raise the
        // floor for LLM jobs only, via backend capabilities, not app minSdk.
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"

        ndk {
            // The fleet's LLM-capable devices are all arm64; 32-bit devices
            // still run the app (LiteRT/synthetic) via the JVM-only code path.
            abiFilters += "arm64-v8a"
        }

        if (!skipNative) {
            externalNativeBuild {
                cmake {
                    // Benchmark numbers must come from optimized code even in
                    // the debug app variant — an -O0 llama.cpp poisons every
                    // result.
                    arguments += "-DCMAKE_BUILD_TYPE=Release"
                }
            }
        }
    }

    if (!skipNative) {
        ndkVersion = "27.2.12479018"

        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    // Model files ride the artifact store, never assets — but keep aapt from
    // ever compressing a .tflite that does end up in the APK.
    androidResources {
        noCompress += "tflite"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // LiteRT (TFLite) — the vision/audio backend; reaches devices far older
    // than llama.cpp needs. GPU delegate is opt-in per job.
    implementation("com.google.ai.edge.litert:litert:1.4.0")
    implementation("com.google.ai.edge.litert:litert-gpu:1.4.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
