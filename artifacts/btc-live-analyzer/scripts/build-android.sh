#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm exec expo prebuild --platform android --no-install
cd android
./gradlew assembleDebug
echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"