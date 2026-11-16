import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Generated Next.js output may exist in any workspace app.
    "**/.next/**",
    "out/**",
    "**/out/**",
    "build/**",
    "**/build/**",
    "next-env.d.ts",
    "**/next-env.d.ts",
  ]),
]);

export default eslintConfig;
