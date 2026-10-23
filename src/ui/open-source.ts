/**
 * What the app is built from, by licence, for Yardım (`docs/TASKS.md` F1.31):
 * every dependency `package.json` names, and the typefaces in `assets/fonts`.
 * Written out rather than read at build time, which would bundle every
 * package's manifest; `tests/ui/legal-notice.test.ts` holds it to both.
 */
export const OPEN_SOURCE: Readonly<Record<string, readonly string[]>> = {
  MIT: [
    "@supabase/realtime-js",
    "@supabase/supabase-js",
    "babel-preset-expo",
    "expo",
    "expo-camera",
    "expo-constants",
    "expo-crypto",
    "expo-document-picker",
    "expo-file-system",
    "expo-font",
    "expo-haptics",
    "expo-image-manipulator",
    "expo-image-picker",
    "expo-linking",
    "expo-local-authentication",
    "expo-notifications",
    "expo-router",
    "expo-secure-store",
    "expo-splash-screen",
    "expo-sqlite",
    "expo-status-bar",
    "expo-system-ui",
    "expo-updates",
    "react",
    "react-dom",
    "react-native",
    "react-native-gesture-handler",
    "react-native-keyboard-controller",
    "react-native-reanimated",
    "react-native-safe-area-context",
    "react-native-screens",
    "react-native-svg",
    "react-native-web",
    "react-native-worklets",
    "zustand",
  ],
  "Apache-2.0": ["drizzle-orm", "uuidv7"],
  ISC: ["lucide-react-native"],
  "SIL OFL 1.1": ["IBM Plex Serif", "Inter"],
};
