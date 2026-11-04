
import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    ignores: ["node_modules/**", "templates/**", "accounts/**"],
    plugins: { js },
    extends: ["js/recommended"],
    rules: {
      // `const { secret, ...rest } = obj` is how the skill scripts drop fields.
      "no-unused-vars": ["error", { ignoreRestSiblings: true }]
    },
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
      ecmaVersion: "latest"
    }
  }
]);
