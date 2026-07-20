/** @type {import('tailwindcss').Config} */
// NativeWind (Tailwind v3) config for the mobile app. Uses the same default
// Tailwind palette as the web (slate/blue/etc.), so the status classes ported
// from the web lib/badge-colors.ts resolve identically. `darkMode: "class"` is
// driven by NativeWind's colorScheme (see design/theme/ThemeProvider).
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
