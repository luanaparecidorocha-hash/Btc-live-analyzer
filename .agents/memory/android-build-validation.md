---
name: Android build validation
description: Environment constraints observed when validating the native Android artifact.
---

The Android project can be prebuilt and its local Expo module can be resolved by autolinking in the workspace. A device APK still requires a persistent Android SDK with the configured platform, build tools, and NDK, plus a stable JDK.

**Why:** The available temporary GraalVM JDK crashed during Gradle resource processing, and subsequent retries can hit workspace quota while assembling a temporary SDK. Treat that as an environment limitation, not evidence that the Kotlin module is invalid.

**How to apply:** For final APK validation, use a development machine or build environment with Java, Android SDK/ADB, the required SDK components, and an Android device or emulator capable of MediaProjection. Do not claim an APK was generated from prebuild or autolinking alone.