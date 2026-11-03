import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/** Path-segment conventions. These are inferences, not observations of runtime behavior. */

export type NativeRuntimeConvention = "react-native" | "flutter" | "unity";

const foldSegment = (segment: string): string =>
  segment.toLocaleLowerCase("en-US");

const REACT_NATIVE_SEGMENTS = new Set([
  "react.framework",
  "reactnative.framework",
  "libreactnative.so",
  "libreactnativejni.so",
  "libhermes_executor.so",
  "libhermes.so",
  "libhermesvm.so",
  "librninstance.so",
  "libturbomodulejsijni.so",
  "libfabricjni.so",
  "libreact_featureflagsjni.so",
  "hermes.framework",
  "hermesvm.framework",
]);

/**
 * Android React Native and Hermes bundle conventions (`assets/*.bundle`,
 * `*.jsbundle`, `*.hbc`) not covered by generic UTF-8 JS source suffixes.
 */
export const isAndroidJavaScriptBundlePath = (path: string): boolean =>
  /\.(?:jsbundle|hbc)$/iu.test(path) ||
  /(?:^|\/)assets\/(?:.+\/)?[^/]+\.bundle$/iu.test(path);

/**
 * Apple React Native and Hermes bundle file conventions (`*.jsbundle`, `*.hbc`).
 * Generic `*.bundle` is excluded because Apple CFBundle plugin directories use `.bundle`.
 */
export const isAppleJavaScriptBundlePath = (path: string): boolean =>
  /\.(?:jsbundle|hbc)$/iu.test(path);

/** HarmonyOS JavaScript, React Native (RNOH), and Hermes bundle file conventions. */
export const isHarmonyJavaScriptBundlePath = (path: string): boolean =>
  /\.(?:m?js|cjs|jsbundle|hbc)$/iu.test(path) ||
  /(?:^|\/)assets\/(?:.+\/)?[^/]+\.bundle$/iu.test(path);

/**
 * Unambiguous React Native / Hermes bundle filenames that indicate React Native
 * even when native libraries are packaged in a separate split APK/HSP.
 */
export const isReactNativeBundleConventionPath = (path: string): boolean =>
  /\.(?:jsbundle|hbc)$/iu.test(path) ||
  /(?:^|\/)assets\/(?:.+\/)?index\.android\.bundle$/iu.test(path) ||
  /(?:^|\/)bundle\.harmony\.(?:js|hbc)$/iu.test(path);

/** Deduplicate path-bearing components in canonical Unicode code-point order. */
export const uniqueComponentsByPath = <T extends { readonly path: string }>(
  items: readonly T[],
): T[] => {
  const byPath = new Map<string, T>();
  for (const item of items) {
    if (!byPath.has(item.path)) byPath.set(item.path, item);
  }
  return [...byPath.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
};
const FLUTTER_SEGMENTS = new Set(["libflutter.so", "flutter.framework"]);
const UNITY_SEGMENTS = new Set(["libunity.so", "unityframework.framework"]);
const DESKTOP_IL2CPP_LIBRARIES = new Set([
  "gameassembly.dll",
  "gameassembly.so",
  "gameassembly.dylib",
  "libil2cpp.so",
]);

/**
 * A runtime family named by the library filename or a containing framework.
 * A library-named ancestor directory does not establish a convention.
 */
export const nativeRuntimeConvention = (
  path: string,
): NativeRuntimeConvention | null => {
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    const folded = foldSegment(segment);
    if (index !== segments.length - 1 && !folded.endsWith(".framework"))
      continue;
    if (REACT_NATIVE_SEGMENTS.has(folded)) return "react-native";
    if (FLUTTER_SEGMENTS.has(folded)) return "flutter";
    if (UNITY_SEGMENTS.has(folded)) return "unity";
  }
  return null;
};

/** Swift runtime libraries are `libswift*.dylib` segments, not every dynamic library. */
export const isSwiftRuntimeLibrary = (path: string): boolean =>
  path
    .split("/")
    .some((segment) => /^libswift.+\.dylib$/u.test(foldSegment(segment)));

/** Parse desktop layout conventions once while preserving original path segments. */
export const desktopPathConventions = (path: string) => {
  const segments = path.split("/");
  const folded = segments.map(foldSegment);
  let unityManagedDirectory: string | null = null;
  for (let index = 0; index + 2 < folded.length; index++) {
    const segment = folded[index];
    const namedDataDirectory =
      segment !== undefined && segment.length > 5 && segment.endsWith("_data");
    const bundleDataDirectory =
      segment === "data" &&
      folded[index - 1] === "resources" &&
      folded[index - 2] === "contents";
    if (
      (namedDataDirectory || bundleDataDirectory) &&
      folded[index + 1] === "managed"
    )
      unityManagedDirectory = segments.slice(0, index + 2).join("/");
  }
  const name = folded.at(-1) ?? "";
  return {
    unityManagedDirectory,
    il2cppLibrary: DESKTOP_IL2CPP_LIBRARIES.has(name),
    electronArchive:
      folded.at(-2) === "resources" &&
      (name === "app.asar" || name === "default_app.asar"),
    unrealContainer:
      (name.endsWith(".pak") || name.endsWith(".utoc")) &&
      folded.some(
        (segment, index) =>
          segment === "content" &&
          folded[index + 1] === "paks" &&
          index + 2 < folded.length,
      ),
  };
};
