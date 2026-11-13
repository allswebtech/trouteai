import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

// Every rule runs as "error". Pre-existing violations are frozen per file+rule in
// config/quality/eslint-suppressions.json (ESLint bulk suppressions), so only NEW
// violations fail `npm run lint`. After fixing old ones, tighten the baseline with:
//   npx eslint . --prune-suppressions --suppressions-location config/quality/eslint-suppressions.json

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...nextVitals,
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "@next/next/no-img-element": "error",
      "import/no-anonymous-default-export": "error",
    },
  },
  // Security rules (everywhere)
  {
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  // Routing engine: plain TS module code, not React components
  {
    files: ["open-sse/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@next/next/no-assign-module-variable": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    ignores: [
      ".build/**",
      ".next/**",
      "dist/**",
      "next-env.d.ts",
      "node_modules/**",
      "scripts/**",
      "bin/**",
      "app.cjs",
    ],
  },
];

export default eslintConfig;
