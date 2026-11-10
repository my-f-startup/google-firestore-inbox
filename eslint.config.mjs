import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default [
  { ignores: ["dist/", "node_modules/", "coverage/", "*.config.js", "*.config.mjs"] },
  js.configs.recommended,
  ...tsPlugin.configs["flat/recommended-type-checked"].map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { project: "./tsconfig.json" },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  prettierRecommended,
];
