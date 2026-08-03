/** @type {import('tailwindcss').Config} */
// NativeWind (Tailwind v3) config for the mobile app. Uses the same default
// Tailwind palette as the web (slate/blue/etc.), so the status classes ported
// from the web lib/badge-colors.ts resolve identically.
//
// ⚠ `darkMode: "class"` DOES NOTHING TODAY. Read this before assuming the app
// has a dark theme.
//
// This comment previously said it was "driven by NativeWind's colorScheme (see
// design/theme/ThemeProvider)". That file does not exist and never did; nothing
// in the app imports `colorScheme`, and no ThemeProvider was written. The
// reference was corrected on 2026-08-03 (Q28) — a comment asserting a mechanism
// that isn't there is exactly what let earlier defects survive review here.
//
// What is actually true:
//   • Only 3 of 56 component/screen files use NativeWind `className` at all.
//     The other 53 style with React Native StyleSheet, which Tailwind `dark:`
//     variants cannot reach by any means.
//   • 55 files import the palette from lib/theme.ts as a STATIC module. There is
//     no theme context, so there is nothing for a colour-scheme change to flow
//     through.
//   • app.json pins `userInterfaceStyle: "light"`, so the OS never reports dark
//     to the app in the first place.
//
// Dark mode here is therefore not a `dark:` class problem. It needs light/dark
// palettes in lib/theme.ts, a provider driven by useColorScheme(), and 55 files
// moved from a static import to a hook. That is a substantial refactor of a
// working app, not a config flag. See Q28 in mobile/DECISIONS-FOR-AVI.md.
//
// `darkMode: "class"` is left in place because removing it would change how the
// 3 NativeWind files compile for no benefit. It is inert, and now says so.
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./design/**/*.{js,jsx,ts,tsx}",
    "./features/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic brand accent — single accent across the app (blue-600/500).
        brand: {
          DEFAULT: "#2563eb", // blue-600
          dark: "#3b82f6", // blue-500 (better AA on dark surfaces)
        },
      },
      fontFamily: {
        sans: ["Geist", "System"],
        mono: ["GeistMono", "monospace"],
      },
    },
  },
  plugins: [],
};
