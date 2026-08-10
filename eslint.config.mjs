import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["desktop-dist/**", "src-tauri/target/**", "release/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["desktop/**/*.{ts,tsx}", "vite.desktop.config.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    },
  },
]);
