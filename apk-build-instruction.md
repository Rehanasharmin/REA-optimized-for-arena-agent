# instruction.md — How an Android Project Must Be Structured, and How to Build an APK in This Environment

> **Purpose of this file only:** teach another AI agent working in the same
> Arena sandbox
>
> 1. **how an Android project must be laid out** so Gradle/AGP can build it, and
> 2. **exactly how the APK in our Gboard reconstruction was built** — every
>    tool installed, every command, every error, and what AGP does internally.
>
> Reverse engineering is intentionally **out of scope** here. Assume the
> source code already exists (or you are writing it); this file starts at
> "empty folder" and ends at "verified, installable `.apk`".
>
> **Proven recipe:** JDK 21 + Gradle 8.9 + AGP 8.7.3 + Kotlin 2.0.21 +
> Android SDK Platform 35 → `./gradlew :app:assembleDebug` →
> `BUILD SUCCESSFUL` → 895,427-byte debug APK (SHA-256
> `714c55ce7228faa8819eb39525dc6207ed5d3edd6e362cfd0aff169b620e903c`).

---

# PART A — WHAT AN APK IS (so the project layout makes sense)

An `.apk` is a **ZIP archive** with a fixed anatomy. Everything in the
project structure below exists to produce one of these entries:

| Inside the APK | Produced from | What it is |
|---|---|---|
| `AndroidManifest.xml` | `app/src/main/AndroidManifest.xml` (+ library manifests, Gradle values) | **Binary** AXML, not text — merged + encoded by AAPT2 |
| `classes.dex`, `classes2.dex`, … | Kotlin/Java sources → JVM `.class` → D8 | Dalvik/ART bytecode; split into multiple DEX when needed |
| `resources.arsc` | `res/values/*` (strings, colors, styles…) | Compiled resource **table** (IDs ↔ values) |
| `res/…` | `app/src/main/res/**` | Compiled XML drawables/layouts/mipmaps, files referenced by `resources.arsc` |
| `assets/…` | `app/src/main/assets/**` | Raw files, copied (usually compressed) verbatim |
| `lib/<abi>/*.so` | `app/src/main/jniLibs/<abi>/` or CMake/NDK build | Native libraries; **absent if the app has no native code** |
| `kotlin/*.kotlin_builtins` | Kotlin stdlib | Metadata for built-in Kotlin types |
| `META-INF/…` | AGP/signing | Build metadata; the v2+ signature lives in an APK Signing Block *before* the ZIP central directory (visible via `apksigner`, not `unzip -l`) |

**Our built APK, verified with `unzip -l`** (25 files, 2,536,052 bytes
uncompressed → 895,427 bytes as a signed, zipaligned APK):

```
META-INF/com/android/build/gradle/app-metadata.properties
classes.dex        2,334,876   <- mostly Kotlin stdlib in a small app
classes2.dex … classes7.dex    <- incremental debug dexing splits inputs
assets/emoji_shortcuts.txt         assets/words_en.txt
AndroidManifest.xml    4,460   <- binary form of our 3.4 KB text manifest
res/drawable/ic_launcher_*.xml
res/mipmap-anydpi-v26/ic_launcher{,_round}.xml
res/xml/method.xml  res/xml/spell_checker.xml
resources.arsc       1,760
kotlin/**.kotlin_builtins ×7
```

Timestamps inside show `1981-01-01` — AGP uses fixed ZIP timestamps for
reproducible builds. The debug signature is **not** a file in the listing;
verify it with `apksigner` (§D7).

---

# PART B — THE PROJECT STRUCTURE (what the project MUST look like)

## B1. Minimum viable tree (single-module Kotlin app)

```
<Name>-Reconstruction/            ← project root (this is what you zip)
├── settings.gradle.kts            REQUIRED  declares modules + repositories
├── build.gradle.kts               REQUIRED  plugin *versions* only (root)
├── gradle.properties              REQUIRED-ish JVM/Android flags
├── gradlew                        REQUIRED  Gradle wrapper (unix launcher)
├── gradlew.bat                    REQUIRED  Gradle wrapper (windows launcher)
├── gradle/wrapper/
│   ├── gradle-wrapper.jar         REQUIRED  downloads the pinned Gradle
│   └── gradle-wrapper.properties  REQUIRED  which Gradle version/URL
├── local.properties               LOCAL ONLY — sdk.dir; NEVER commit/zip it
├── .gitignore
└── app/                           the application module (":app")
    ├── build.gradle.kts           REQUIRED  Android config for this module
    ├── proguard-rules.pro         required only if R8/minify is enabled
    └── src/
        ├── main/                  the "main" source set (ships in the APK)
        │   ├── AndroidManifest.xml     REQUIRED
        │   ├── java/<package/path>/    Kotlin/Java sources (.kt/.java)
        │   ├── res/
        │   │   ├── values/strings.xml, themes.xml, colors.xml …
        │   │   ├── layout/*.xml        (only if you inflate layouts)
        │   │   ├── drawable/*.xml|png|webp
        │   │   ├── mipmap-anydpi-v26/ic_launcher.xml (+ density folders)
        │   │   ├── xml/*.xml           (app config XML: method.xml, etc.)
        │   │   ├── raw/*               (raw resources, get an R.raw id)
        │   │   └── font/*.ttf|xml
        │   ├── assets/**               raw files (AssetManager.open())
        │   └── jniLibs/<abi>/*.so      ONLY for prebuilt native libs
        ├── test/java/<package>/        JVM unit tests (run on desktop)
        ├── androidTest/java/<package>/ device/emulator tests
        └── debug/, release/            optional per-build-type source sets
```

Rules that break builds when violated:

* **Package = directory path.** `package org.example.cleanboard.engine`
  lives in `java/org/example/cleanboard/engine/`. Kotlin files may sit in
  `java/` (the Kotlin plugin compiles them); `kotlin/` also works.
* **Resource file names:** lowercase `a-z0-9_` only, and the folder decides
  the type (`res/values`, `res/layout`, `res/drawable-…`, `res/xml`).
  A bad name or a missing `@string/…` reference fails at **AAPT2 link**.
* **One module is enough.** Add modules (`include(":lib")` in settings)
  only for a real library boundary; each extra module adds build time.
* **`build/`, `.gradle/`, `local.properties` are generated/local** — never
  required in the zip. The **wrapper files ARE required**: without them
  the recipient needs a system Gradle of exactly the right version.

## B2. `settings.gradle.kts` — where plugins/dependencies come from

Exact file that built our APK:

```kotlin
pluginManagement {
    repositories {
        google()              // AGP + AndroidX live on dl.google.com
        mavenCentral()        // Kotlin plugin + most libraries
        gradlePluginPortal()  // Gradle plugins
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "CleanBoard"
include(":app")
```

* `pluginManagement` = where **plugins** (AGP, Kotlin) are resolved.
* `dependencyResolutionManagement` = where **libraries** come from;
  `FAIL_ON_PROJECT_REPOS` means modules may not declare their own repos
  (prevents accidental split configuration).
* `include(":app")` registers the `app/` folder as a Gradle subproject.

## B3. Root `build.gradle.kts` — versions in exactly one place

```kotlin
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
```

`apply false` = "put this plugin version on the classpath, apply it in the
module that needs it." This version pair is the compatibility contract:
**AGP 8.7.3 needs Gradle ≥ 8.9 and JDK 17+**; Kotlin 2.0.21 pairs with it.
If you change one, check the others — §E has the failure modes.

## B4. `app/build.gradle.kts` — the file that defines the APK (line by line)

The actual file, annotated:

```kotlin
plugins {                                  // apply (versions from root)
    id("com.android.application")          // AGP: builds an application APK
    id("org.jetbrains.kotlin.android")     // compiles Kotlin, adds stdlib
}

android {
    namespace = "org.example.cleanboard"   // (1)
    compileSdk = 35                        // (2)

    defaultConfig {
        applicationId = "org.example.cleanboard"  // (3)
        minSdk = 26                        // (4)
        targetSdk = 35                     // (5)
        versionCode = 1                    // (6)
        versionName = "1.0-reconstruction"
    }

    buildTypes {                           // (7)
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {                       // (8)
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }     // MUST match (8)
}

dependencies { /* empty on purpose — see B7 */ }
```

1. **`namespace`** — package for the generated `R` class and build
   machinery. Required by modern AGP (it replaced the manifest `package=`).
2. **`compileSdk`** — the `android.jar` stub API you *compile against*
   (Platform 35 must be installed). It does **not** change runtime behaviour.
3. **`applicationId`** — install/Play identity of the finished app. Must be
   unique and **yours**; two APKs with the same applicationId but different
   signing keys cannot install over each other.
4. **`minSdk`** — oldest Android that may install the APK (26 = Android 8.0
   in our build, matching the original target app).
5. **`targetSdk`** — the newest behaviour level you opt into (runtime
   permissions, background limits…). Use the current **stable** API even if
   some reference app targets a developer-preview API.
6. **`versionCode`** — integer, must increase per release; **`versionName`**
   is display-only text. Both are visible in `aapt2 dump badging`.
7. **`buildTypes`** — AGP always creates `debug` (debuggable, auto
   debug-signed) and `release`. `isMinifyEnabled=true` turns on R8
   shrinking/obfuscation + makes `proguard-rules.pro` matter (§D8).
8. **Java/Kotlin target must agree** (17/17). A mismatch is the classic
   "Inconsistent JVM-target compatibility" build failure.

## B5. `gradle.properties` + wrapper properties (actual files)

```properties
# gradle.properties
org.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8
org.gradle.caching=true
android.useAndroidX=false        # we use zero AndroidX libraries (B7)
android.nonTransitiveRClass=true
kotlin.code.style=official
```

```properties
# gradle/wrapper/gradle-wrapper.properties  (generated, do not hand-edit)
distributionUrl=https\://services.gradle.org/distributions/gradle-8.9-bin.zip
```

`local.properties` contains **one machine-specific line** created locally —
`sdk.dir=/home/user/.cache/android-sdk` — and is listed in `.gitignore`.
If `sdk.dir` and `$ANDROID_SDK_ROOT` are both missing, AGP fails with
"SDK location not found". **Delete this file before zipping**; the next
machine regenerates it (Android Studio does it automatically).

## B6. `AndroidManifest.xml` — what AGP needs from it

* Root `<manifest xmlns:android="…">` — **no `package=` attribute** with
  modern AGP; the value comes from `namespace`/`applicationId` at merge
  time. (Flag: if you ever link resources by hand with `aapt2`, you must
  inject `package=` into a *copy* — see §D3, rung 2.)
* `<uses-permission>` entries (ours: exactly one, `VIBRATE`).
* One `<application>` with `android:label`, `android:icon`,
  `android:roundIcon`, `android:theme` referencing real resources.
* **Every** `Activity`/`Service`/`Receiver`/`Provider` in code must be
  declared here, with `android:exported` explicitly set on any component
  that has an `<intent-filter>` (required since API 31 — missing it fails
  the manifest merger).
* Specialised components follow the platform contract exactly. Two from
  our build — an input method and a spell checker:

```xml
<service android:name=".CleanBoardIME"
    android:exported="true"
    android:permission="android.permission.BIND_INPUT_METHOD">
    <intent-filter><action android:name="android.view.InputMethod"/></intent-filter>
    <meta-data android:name="android.view.im" android:resource="@xml/method"/>
</service>
<activity android:name=".settings.LauncherActivity" android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter>
</activity>
```

  For a normal GUI app only the LAUNCHER activity is needed. AGP also
  writes `output-metadata.json` next to the APK and a merger report in
  `app/build/outputs/logs/` — read that report first when merging fails.

## B7. Dependencies — why our block is empty, and how to add real ones

Our app deliberately uses **platform APIs + Kotlin stdlib only** (added
automatically by the Kotlin plugin): `InputMethodService`, custom `View`
drawing, `SharedPreferences`, `SpellCheckerService`. Result: the only
network fetches at build time are Gradle itself, AGP and the Kotlin
plugin — the build works in this sandbox and will still work in years.

When an app genuinely needs libraries, add them by **configuration**:

```kotlin
dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")   // ships in APK
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation("junit:junit:4.13.2")               // desktop tests
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    debugImplementation("…")                               // debug builds only
}
```

`implementation` = needed to compile+run this module, hidden from
consumers (use `api` only for library modules). Using any AndroidX
artifact flips the project to `android.useAndroidX=true`; Jetpack Compose
additionally needs the Compose compiler plugin + `buildFeatures { compose = true }`
and a BOM — do not add it casually in a 2 GB sandbox; Views build far
faster and are what our project used.

## B8. Code organisation that keeps the build (and tests) simple

```
java/org/example/cleanboard/
├── CleanBoardIME.kt        Android glue: Service lifecycle → engine calls
├── model/                  pure data classes (NO android imports)
├── engine/                 PURE JVM algorithms (NO android imports)
│   ├── Dictionary.kt  NGramModel.kt  EditDistance.kt
│   ├── SuggestionEngine.kt  ComposingStateMachine.kt
│   ├── GestureDecoder.kt  AhoCorasick.kt  EmojiShortcutMap.kt
├── data/                   java.io/security logic + Android prefs store
├── ui/KeyboardView.kt      custom View
├── settings/Activities.kt  Launcher/FirstRun/Settings screens
├── spellcheck/             SpellCheckerService
└── theme/                  colour-slot style sheets
```

The hard rule is the `engine/`+`model/` purity: because they import
nothing from `android.*`, the same files compile with a desktop
`kotlinc` and run under a plain `main()` test harness **before any SDK
exists** (§D3). Android-facing classes stay thin translators
(`EditorInfo` flags → engine config; key events → state machine;
state-machine callbacks → `InputConnection`). Any app type maps onto this:
parser/scorer/ranker/engine in `engine/`, Activities/Services as glue.

Native code, when an app needs it: prebuilt `.so` files go in
`app/src/main/jniLibs/arm64-v8a/` (and per-ABI siblings); C/C++ sources go
in `app/src/main/cpp/` with
`externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt") } }`
in `app/build.gradle.kts` (requires NDK + CMake from sdkmanager). Our
build had **no native code** — hence no `lib/` entry in the APK.

---

# PART C — THIS SANDBOX, AS IT ACTUALLY IS

Measured at build time: **2 vCPU, 1,982 MB RAM (+2 GB swap), 25 GB disk**.
Preinstalled: Java 11/21/25, Python 3, Debian `aapt`/`aapt2` only — **no
Android SDK platform, no Gradle, no kotlinc**. Non-obvious constraints:

| Fact | Consequence for building |
|---|---|
| `/tmp` = 992 MB tmpfs | Put SDK/Gradle/targets in **`/home/user/.cache/`**, never `/tmp` (a Gradle dist alone is 130 MB; an SDK install unpacks several hundred MB) |
| Only `/home/user` persists; snapshot caps ≈128 MB/10k files; `.cache`, `build`, `node_modules`, … excluded | Heavy tooling goes in `.cache` (fast + invisible to the snapshot). The deliverable folder itself must stay small — build outputs are excluded by name, but clean them anyway before zipping |
| Shell state does not persist between tool calls | Re-export `JAVA_HOME`, `ANDROID_SDK_ROOT`, `GRADLE_USER_HOME` in **every** command block |
| JDK 25 is the default `java` | Kotlin 2.0.21 crashes on it (`IllegalArgumentException: 25.0.5`). **Always `export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64` for kotlinc/Gradle** |
| Gradle daemon + Kotlin daemon in 2 GB | Build with `--no-daemon -Dorg.gradle.jvmargs=-Xmx1200m`; don't run other JVM-heavy tools at the same time |
| No emulator/device | You can build, sign and inspect the APK; "run the app" stops at `aapt2 dump badging`. Say so in the build log |

Proven directory layout:

```
/home/user/.cache/android-sdk/     sdkmanager SDK (platform 35, build-tools)
/home/user/.cache/tools/           gradle-8.9/, kotlinc/
/home/user/.cache/gradle-home/     GRADLE_USER_HOME (wrapper dist + caches)
/home/user/<Name>-Reconstruction/  the project (Part B tree)
```

---

# PART D — HOW OUR APK WAS BUILT, STEP BY STEP (the exact run)

## D1. Scaffold the project

Directories first, then the five build files exactly as in Part B:

```bash
mkdir -p /home/user/<Name>-Reconstruction/app/src/main/java/<pkg/path>/{engine,model,data,ui,settings,spellcheck,theme}
mkdir -p /home/user/<Name>-Reconstruction/app/src/main/{res/{layout,values,xml,drawable,mipmap-anydpi-v26},assets}
mkdir -p /home/user/<Name>-Reconstruction/app/src/test/java/<pkg/path>
# write settings.gradle.kts, build.gradle.kts, app/build.gradle.kts,
# gradle.properties, proguard-rules.pro, AndroidManifest.xml,
# res/values/*.xml, launcher icons, sources, assets  (Part B)
```

## D2. Write code in an order that fails early

Pure engines first (`model/`, `engine/`, `data/` logic), then Android glue
(IME/View/Activities), then manifest/resources. Reason: rung 1 below can
compile and test the heart of the app before 500 MB of SDK exists, and
Android errors then isolate to glue/resources instead of everything at once.

## D3. Validate in three rungs (cheapest first — all three were run)

**Rung 1 — desktop Kotlin compile + logic tests.** Download the standalone
compiler once (82 MB):

```bash
cd /home/user/.cache/tools
curl -fsSL -o kotlin.zip https://github.com/JetBrains/kotlin/releases/download/v2.0.21/kotlin-compiler-2.0.21.zip
unzip -q kotlin.zip
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64; export PATH=$JAVA_HOME/bin:$PATH
cd /home/user/<Name>-Reconstruction
/home/user/.cache/tools/kotlinc/bin/kotlinc \
  $(find app/src/main/java/<pkg>/model app/src/main/java/<pkg>/engine \
         app/src/main/java/<pkg>/data -name '*.kt' | grep -v UserDataStore) \
  app/src/test/java/<pkg>/EngineChecks.kt \
  -include-runtime -d /tmp/engine-checks.jar
java -jar /tmp/engine-checks.jar app/src/main/assets/words_en.txt
```

`EngineChecks.kt` is a plain `main()` (no JUnit dependency) printing
`PASS/FAIL` per assertion and exiting non-zero on failure. Our result:
**27/27 PASS**. One real compile error happened here in the original run:
a `var composing` property clashes on the JVM with a `setComposing()`
method → renamed to `lastComposing`.

**Rung 2 — resources with the preinstalled Debian AAPT2** (proves manifest
+ every `@string/@style/@mipmap/@xml` reference resolves):

```bash
aapt2 compile --dir app/src/main/res -o /tmp/res.zip
sed 's|<manifest xmlns:android="http://schemas.android.com/apk/res/android">|<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.example.cleanboard">|' \
  app/src/main/AndroidManifest.xml > /tmp/AndroidManifest.xml
aapt2 link -o /tmp/unsigned.apk \
  -I /usr/share/android-framework-res/framework-res.apk \
  --manifest /tmp/AndroidManifest.xml --java /tmp/gen \
  --min-sdk-version 26 --target-sdk-version 34 /tmp/res.zip
# -> exit 0, generates gen/org/example/cleanboard/R.java + resources-only APK
```

(The `package=` injection is only for this manual link; AGP supplies it
from `namespace` and the shipped manifest must not contain it.)

**Rung 3 — the real Gradle build** (§D4–D6). Only rung 3 produces a signed,
installable APK. Do not report "buildable" from rungs 1–2 alone.

## D4. Install the Android SDK (once, ~10 s download + unpack on this host)

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_SDK_ROOT=/home/user/.cache/android-sdk ANDROID_HOME=$ANDROID_SDK_ROOT
mkdir -p $ANDROID_SDK_ROOT/cmdline-tools && cd $ANDROID_SDK_ROOT/cmdline-tools
curl -fsSL -o cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
#                                                147 MB ^^^
unzip -q cmdtools.zip && mv cmdline-tools latest   # ← must end as cmdline-tools/latest/bin/sdkmanager
yes | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager \
        --sdk_root=$ANDROID_SDK_ROOT --licenses
$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --sdk_root=$ANDROID_SDK_ROOT \
  "platforms;android-35" "build-tools;35.0.0" "platform-tools"
ls $ANDROID_SDK_ROOT/platforms/android-35/android.jar   # the compileSdk stub jar
```

* `platforms;android-35` → `android.jar` that `compileSdk = 35` compiles
  against. Build fails with "Failed to find target with hash string
  'android-35'" without it.
* `build-tools;35.0.0` → real `aapt2`, `d8`, `zipalign`, `apksigner`.
  AGP 8.7.3 *also* auto-installed Build-Tools **34** on first build
  (its default) — expected, harmless, needs the accepted licences.
* `platform-tools` → `adb` (for installing on a device, if one existed).

## D5. Generate the Gradle wrapper (once)

```bash
cd /home/user/.cache/tools
curl -fsSL -o gradle.zip https://services.gradle.org/distributions/gradle-8.9-bin.zip   # 130 MB
unzip -q gradle.zip
export GRADLE_USER_HOME=/home/user/.cache/gradle-home
cd /home/user/<Name>-Reconstruction
echo "sdk.dir=/home/user/.cache/android-sdk" > local.properties
/home/user/.cache/tools/gradle-8.9/bin/gradle wrapper --gradle-version 8.9 --distribution-type bin
```

This creates `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`
(43,504 B) and `gradle-wrapper.properties` pointing at
`gradle-8.9-bin.zip`. From now on **only `./gradlew` is used** — the first
`./gradlew` invocation re-downloads the distribution into
`GRADLE_USER_HOME/wrapper/dists`, which is why the project's build is
reproducible on any machine. (Android Studio users get this for free;
headless agents must bootstrap it like this.)

## D6. Build — including the failure we actually hit

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_SDK_ROOT=/home/user/.cache/android-sdk ANDROID_HOME=$ANDROID_SDK_ROOT
export GRADLE_USER_HOME=/home/user/.cache/gradle-home
cd /home/user/<Name>-Reconstruction
./gradlew :app:assembleDebug --no-daemon -Dorg.gradle.jvmargs=-Xmx1200m
```

**First run failed** at `:app:compileDebugKotlin` after 51 s:

```
e: …/data/UserDataStore.kt:36:55 The feature "break continue in inline
   lambdas" is experimental and should be enabled explicitly
```

The offending code used `continue` inside a `.let {}`. Fix (one edit):

```kotlin
// before
val (prev, word) = pair.split(" ", limit = 2).let {
    if (it.size == 2) it[0] to it[1] else continue
}
// after
val parts = pair.split(" ", limit = 2)
if (parts.size != 2) continue
ngram.observe(parts[0], parts[1])
```

**Second run:** `BUILD SUCCESSFUL in 31s — 33 actionable tasks: 8 executed,
25 up-to-date`. The 25 up-to-date tasks are the point of Gradle's
incremental cache: resources/manifest/dex of unchanged inputs are reused.
A clean build (`./gradlew clean :app:assembleDebug`) re-executes all 33.

What those 33 tasks actually do (AGP pipeline, in dependency order):

| Stage | Representative tasks | Output |
|---|---|---|
| Resources | `generateDebugResValues`, `mergeDebugResources`, `packageDebugResources` | AAPT2-compiled `.flat` files, merged `res/` |
| Manifest | `processDebugMainManifest`, `processDebugManifest(ForPackage)` | merged binary manifest (namespace + version/min/target injected from Gradle) |
| Link | `processDebugResources` | `resources.arsc`, compiled `res/**`, generated `R` classes |
| Compile | `compileDebugKotlin`, `compileDebugJavaWithJavac` (NO-SOURCE for us) | JVM `.class` files against `android.jar` |
| Dex | `desugarDebugFileDependencies`, `dexBuilderDebug`, `mergeProjectDexDebug`, `mergeExtDexDebug`, `mergeLibDexDebug` | D8 turns bytecode into `classes*.dex` (Kotlin stdlib included; debug dexes incrementally) |
| Assets/libs | `mergeDebugAssets`, `compressDebugAssets`, `mergeDebugJniLibFolders` (NO-SOURCE when no native code) | `assets/` ready to package |
| Package & sign | `validateSigningDebug`, `packageDebug`, `createDebugApkListingFileRedirect`, `assembleDebug` | zipaligned, **debug-signed** APK |

Artifacts land in:

```
app/build/outputs/apk/debug/
├── app-debug.apk            ← THE APK (895,427 B in our build)
└── output-metadata.json     ← applicationId/variant/version, used by tooling
app/build/outputs/logs/manifest-merger-debug-report.txt
app/build/intermediates/…    ← merged res, dex, compiled classes (inspect on failure)
```

**Debug signing** needs no setup: AGP signs with the standard debug
keystore it creates at `~/.android/debug.keystore`
(alias `androiddebugkey`, password `android`, DN
`C=US, O=Android, CN=Android Debug`). Our sandbox cert SHA-256 was
`e8033a9ba1c72b6c8fb19d5c8995cc10649efa7f8dc1e419f8f5757d77bd49b9`;
any other machine's debug key differs, so the APK hash differs too —
state that when quoting hashes.

## D7. Verify the APK (never ship an unverified one)

```bash
APK=app/build/outputs/apk/debug/app-debug.apk
ls -lh $APK && sha256sum $APK
unzip -l $APK                                   # anatomy vs Part A
$ANDROID_SDK_ROOT/build-tools/35.0.0/apksigner verify --print-certs $APK
$ANDROID_SDK_ROOT/build-tools/35.0.0/aapt2 dump badging $APK | head -20
#  package: name='org.example.cleanboard' versionCode='1'
#           versionName='1.0-reconstruction' compileSdkVersion='35'
#  minSdkVersion:'26'  targetSdkVersion:'35'
#  uses-permission: android.permission.VIBRATE
#  launchable-activity: …LauncherActivity   provides-component:'ime'
$ANDROID_SDK_ROOT/build-tools/35.0.0/aapt2 dump xmltree $APK AndroidManifest.xml | head -40
```

Record all of this in `evidence/test-run.txt`: rung results, the exact
Gradle command, `BUILD SUCCESSFUL`, APK path/size/SHA-256, badging
summary, and any compile fix you made. If a device/emulator existed, the
install step would be:

```bash
adb install $APK
adb shell ime enable org.example.cleanboard/org.example.cleanboard.CleanBoardIME
adb shell ime set    org.example.cleanboard/org.example.cleanboard.CleanBoardIME
```

## D8. Release builds (for completeness — our zip shipped debug)

A **release** APK is the same pipeline with your own key and (usually) R8:

```bash
# 1) Create a keystore ONCE, store it outside the project/zip, never commit it
keytool -genkeypair -v -keystore ~/release.keystore -alias release \
  -keyalg RSA -keysize 2048 -validity 10000

# 2) Reference it via environment/gradle properties, not literals in git
```

```kotlin
// app/build.gradle.kts
android {
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("KEYSTORE_PATH") ?: "missing.keystore")
            storePassword = System.getenv("KEYSTORE_PASSWORD")
            keyAlias = System.getenv("KEY_ALIAS")
            keyPassword = System.getenv("KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true        // R8 shrink + obfuscate
            isShrinkResources = true      // strip unused res (needs minify)
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"),
                          "proguard-rules.pro")
        }
    }
}
```

```bash
./gradlew :app:assembleRelease   # -> app/build/outputs/apk/release/app-release.apk
./gradlew :app:bundleRelease     # -> .aab (Android App Bundle) for Play upload
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Differences that matter: **unsigned release APK cannot be installed**;
R8 will rename/strip anything not reachable or `-keep`-ed (manifest-named
components, JNI entry points, reflection/serialization classes need keep
rules — our `proguard-rules.pro` is the minimal example); always smoke-test
the *release* artifact, not just debug; Play wants the **`.aab`**, sideloading
wants the **`.apk`**.

## D9. Package the project for handoff

```bash
cd /home/user/<Name>-Reconstruction
cp app/build/outputs/apk/debug/app-debug.apk <App>-debug.apk   # keep the binary at zip root
./gradlew clean || rm -rf app/build build .gradle .kotlin
rm -f local.properties                     # sandbox sdk.dir — would break others
cd /home/user && zip -r -q <Name>-Reconstruction.zip <Name>-Reconstruction
sha256sum <Name>-Reconstruction.zip
# verify the FILE, not the folder:
rm -rf /home/user/.cache/verify && unzip -q <Name>-Reconstruction.zip -d /home/user/.cache/verify
ls /home/user/.cache/verify/<Name>-Reconstruction/
```

Keep in the zip: sources, resources, Gradle files **and wrapper**
(`gradlew*` + `gradle/wrapper/*`), docs, prebuilt debug APK.
Keep out: `build/`, `.gradle/`, `local.properties`, keystores, the SDK,
`~/.cache` tooling. Our shipped zip: 72 files, 1.1 MB
(SHA-256 `def0112513c3fb1b4320129e404fe6fe50de9f2a7c6f2da8a5a8465b6183e980`).

---

# PART E — BUILD TROUBLESHOOTING (symptom → cause → fix)

| Symptom | Cause | Fix |
|---|---|---|
| `SDK location not found` | no `local.properties` / env var | `echo "sdk.dir=$ANDROID_SDK_ROOT" > local.properties` |
| `Licence not accepted` / AGP auto-installs build-tools then stalls | licences unaccepted | `yes \| sdkmanager --licenses` (D4) |
| `Failed to find target … android-35` | Platform 35 not installed | `sdkmanager "platforms;android-35"` |
| `IllegalArgumentException: 25.0.5` from kotlinc/Gradle | JDK 25 too new for Kotlin 2.0.x | `JAVA_HOME=…/java-21-openjdk-amd64` |
| `Inconsistent JVM-target compatibility (17 vs 21)` | `compileOptions` ≠ `kotlinOptions.jvmTarget` | set both to `"17"` (B4 #8) |
| `Namespace not specified` | AGP ≥8 without `namespace` | add `namespace` in module build file; remove manifest `package=` |
| Manifest merger: `android:exported needs to be explicitly specified` | intent-filter component, API 31+ rule | add `android:exported="true/false"`; read `outputs/logs/manifest-merger-*.txt` |
| `AAPT: error: resource string/xxx not found` | typo/missing value, bad file name | fix `res/`; rung-2 `aapt2 link` isolates this fast |
| `break continue in inline lambdas is experimental` | `continue` inside `.let{}` | hoist the check out of the lambda (D6) |
| `Platform declaration clash … setX` | `var x` + `fun setX()` collide on JVM | rename one of them |
| `Duplicate class …` | same library twice (direct + transitive) | `./gradlew :app:dependencies` to find it; exclude or align versions |
| `Cannot fit requested classes in a single dex` | >64k methods on minSdk <21 | minSdk ≥21 uses ART multidex natively; else `multiDexEnabled=true` |
| Daemon `OutOfMemoryError` / process killed | 2 GB RAM | `--no-daemon`, `-Xmx1200m`, stop other JVM tools, retry |
| Plugin resolution times out / 401/404 | repo missing (`google()` for AGP) or offline | settings repos per B2; first build **needs network** |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` on device | same applicationId, new signing key | uninstall first, or bump key consistently |
| Release app crashes, debug fine | R8 stripped/renamed something reflective | add `-keep` rules; test the release APK (D8) |
| Zip recipient: `./gradlew: Permission denied` | exec bit lost in transit | `chmod +x gradlew` (zip with `zip -r` on Linux preserves it) |

Debug workflow for any Gradle failure: re-run with the failing task named
in the error (`:app:compileDebugKotlin` = your code, `:app:mergeDebugResources`
= XML/resources, `:app:processDebugMainManifest` = manifest), read the
**first** `e:`/`error:` line (the rest is cascade), fix exactly that, rebuild.

---

# PART F — AGENT CHECKLIST & TASK TEMPLATE

- [ ] Tree matches Part B; five build files written; versions pinned (B3)
- [ ] `applicationId` is mine; min/target/compileSdk chosen and justified
- [ ] Engines/algorithms free of `android.*` imports
- [ ] Rung 1: `kotlinc` checks **all PASS** (output saved)
- [ ] Rung 2: `aapt2 compile` + `link` exit 0
- [ ] SDK Platform 35 + build-tools installed; licences accepted
- [ ] Wrapper generated; `local.properties` created (and git-ignored)
- [ ] `./gradlew :app:assembleDebug` = **BUILD SUCCESSFUL** (or honest failure note)
- [ ] APK verified: `unzip -l`, `apksigner verify`, `aapt2 dump badging`; SHA-256 recorded
- [ ] Build dirs + `local.properties` removed; debug APK copied to project root
- [ ] Zip built, re-unzipped elsewhere, contents verified, SHA-256 recorded
- [ ] Final message presents the zip with size + hashes + build status

```
TASK TEMPLATE — paste to the agent together with this file:
Follow instruction.md Parts B-F. Build an Android app named <Name>:
- Package/applicationId: <org.example.name>
- minSdk <26>, target/compileSdk 35, Kotlin, single :app module
- Features to implement: <short list, or "the code in <folder>">
Deliver /home/user/<Name>.zip containing the full Gradle project
(wrapper included), the built <Name>-debug.apk, and evidence/test-run.txt
with the gradle output + APK SHA-256. Present the zip when done.
```

*— End. If a step here disagrees with a tool's own `--help`/error message on
your run, trust the tool, fix forward, and write down what differed — that
honesty is what made the build in this file believable.*
