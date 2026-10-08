plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// GitHub Actions passes the run number, so every build installs over the last one.
val buildNumber = (System.getenv("VERSION_CODE") ?: "1").toInt()

android {
    namespace = "com.samkiller222.jpcardscanner"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.samkiller222.jpcardscanner"
        minSdk = 24
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // A fixed key so updates install over the previous version. Set the KEYSTORE_*
    // environment variables (e.g. from GitHub secrets) to sign with your own key instead.
    signingConfigs {
        create("sideload") {
            storeFile = file(System.getenv("KEYSTORE_FILE") ?: "../keystore/sideload.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "jpcardscanner"
            keyAlias = System.getenv("KEY_ALIAS") ?: "sideload"
            keyPassword = System.getenv("KEY_PASSWORD") ?: "jpcardscanner"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
        debug {
            signingConfig = signingConfigs.getByName("sideload")
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
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("com.google.android.material:material:1.12.0")

    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")

    // On-device text reading: Latin for the card code, Japanese for the card name
    implementation("com.google.mlkit:text-recognition:16.0.1")
    implementation("com.google.mlkit:text-recognition-japanese:16.0.1")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")

    testImplementation("junit:junit:4.13.2")
}
