import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist", "src-tauri", "node_modules"]),
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // `const { [key]: _, ...rest } = obj` is how the store drops a key.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // Non-component exports that fast refresh can live with.
      "react-refresh/only-export-components": [
        "error",
        { allowConstantExport: true, allowExportNames: ["confirmAction", "MODE_OPTIONS"] },
      ],
      // These rules are written for the React Compiler, which this app doesn't use.
      // They flag deliberate patterns here: latest-value refs, effects that reset state
      // when a prop changes, and Date.now() in event handlers.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/globals": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.{js,ts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
