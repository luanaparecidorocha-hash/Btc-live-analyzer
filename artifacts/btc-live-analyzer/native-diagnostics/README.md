# In-app startup diagnostics (Android)

This is instrumentation, **not a confirmed crash fix**. No APK was generated
when preparing it. The installed APK does not change until a future authorized
build includes these files.

`android/` is generated and ignored by Git. The small startup config plugin is
necessary to regenerate the early Application hooks, copy the native diagnostic
Activity and route launcher/deep links through it. Existing Expo plugin settings,
SDK/dependencies, package ID and EAS build profiles are unchanged.

## Capture and phone-only export

- The Java uncaught handler is installed in `attachBaseContext`, before React
  Native initialization. It saves the original Throwable/causes/stack and then
  delegates to Android's existing fatal handler. It never reports fatal success.
- Startup phases and JS global errors are recorded synchronously through an Expo
  function returning `null`. The original JS handler remains responsible for
  fatal behavior. Caught React render errors are labeled separately.
- Own-process logcat is best effort and limited to the first 120 seconds; no
  READ_LOGS permission or external apps are needed. The Java handler remains
  active afterward.
- `ApplicationExitInfo` reads previous processes of this same package. SIGSEGV,
  SIGABRT and ANR are not catchable by the Java handler; Android may supply an
  exit reason and trace. Binary traces retain original bytes (limit 2 MB,
  explicitly reported if reached). Native traces may require symbol/protobuf
  decoding. Android does not guarantee a trace.
- After a recorded failure, fatal Android exit, or unfinished startup, the
  **next launch** shows a plain Android diagnostic screen before loading
  React/Hermes. An unfinished marker is not proof of a crash.
- Save an ordinary non-empty `.txt` through Android's file picker or share the
  text. A separate button saves an Android trace if available. The native UI
  works without the analyzer screen or a computer.
- “Tentar abrir o aplicativo” retains logs and retries normal initialization.
  It does not erase analysis history, stop capture, rewrite the engine or
  change the five-minute window.

Records are bounded, local and placed in `noBackupFilesDir`, not uploaded or
included in Android Auto Backup. Startup flags are private preferences.
Exports are user-initiated and may contain app logs, firmware/model and stack
details; review before sharing.

## Known limitations

Crashes before Application attachment, hard power loss, storage failure and some
native terminations may leave no Java stack. Previous exit records can belong to
an older APK: always compare timestamps, stage markers and collector metadata.
Minified JS errors may need the source map from the same authorized build.

Local typechecks, plugin tests and Expo prebuild validate wiring, not Android
device execution. Native compilation and phone-only saving/recovery must be
verified when an APK build is authorized.
