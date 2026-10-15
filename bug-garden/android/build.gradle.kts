// The same Android Gradle Plugin, Kotlin and Gradle versions as runner-android/,
// so one toolchain builds both and nobody has to download a second AGP to try
// the bug garden. The Compose compiler is a Kotlin plugin since Kotlin 2.0 and
// has to match the Kotlin version exactly.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
}
