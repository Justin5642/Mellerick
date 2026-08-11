import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

// eslint-config-next is pinned to the Next 15 line to match next@15.5 (a v16
// config against a v15 app pulled in rules that don't apply). The mobile/
// Expo app is a separate project with its own toolchain, so it is ignored here
// and linted by its own flat config: mobile/eslint.config.js, run by
// `npm run lint` in mobile/ and gated in CI (.github/workflows/ci.yml, mobile
// job). That is why `mobile/**` is in `ignores` below — it is delegation, not
// an exemption.
//
// This comment used to say mobile "gets expo-doctor + tsc instead". The tsc
// half was true; the expo-doctor half never was — it appears in no script and
// no workflow, only as a suggestion in a metro.config.js comment. It was
// written when mobile really had no linter (item N3), and it outlived that by
// long enough to be cited as the reason mobile did not need one.
const eslintConfig = [
  { ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "mobile/**", "coverage/**", "supabase/functions/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // The codebase deliberately uses `any` for external, loosely-typed shapes
      // (Supabase row joins, Xero/Google SDK error objects). Rewriting all of
      // them with precise types is a separate typing initiative, not part of
      // this security-hardening pass — kept visible as a warning rather than
      // failing the build (or triggering a risky mass edit). Logged for Avi.
      "@typescript-eslint/no-explicit-any": "warn",
      // react-pdf renders to PDF, not the DOM, so apostrophes in <Text> are not
      // HTML entities — this rule is a false positive for lib/pdf/* templates.
      "react/no-unescaped-entities": "off",
    },
  },
];

export default eslintConfig;
