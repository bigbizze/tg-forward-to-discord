// eslint.config.ts - Base config for TypeScript backend monorepo
import tseslint from "@typescript-eslint/eslint-plugin";
// @ts-ignore - Parser types not fully compatible
import tsparser from "@typescript-eslint/parser";
// @ts-ignore - Plugin types not fully compatible
import unusedImports from "eslint-plugin-unused-imports";
// @ts-ignore - Plugin types not fully compatible
import importNewlines from "eslint-plugin-import-newlines";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import type { Linter } from "eslint";

const config: Linter.Config[] = [
  // Global ignores - exclude build artifacts and generated files
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/apps/python-scraper/**"  // Python files handled separately
    ]
  },

  // Base TypeScript rules for all .ts files
  {
    files: [ "**/*.ts" ],
    plugins: {
      // @ts-ignore - Plugin type compatibility
      "@typescript-eslint": tseslint,
      "@stylistic": stylistic,
      "unused-imports": unusedImports,
      "import-newlines": importNewlines
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      },
      globals: {
        ...globals.node
      }
    },
    rules: {
      // === Import Management ===
      // Remove unused imports automatically - keeps code clean
      "unused-imports/no-unused-imports": "error",
      // Enforce newlines in imports with more than 3 items - improves readability
      "import-newlines/enforce": [
        "error",
        { "items": 3, "semi": true }
      ],

      // === Code Style - Spacing & Punctuation ===
      // 2-space indentation with special handling for switch cases
      "@stylistic/indent": [ "error", 2, { SwitchCase: 1 } ],
      // Always use semicolons - prevents ASI-related bugs
      "@stylistic/semi": [ "error", "always" ],
      // Consistent spacing around type annotations
      "@stylistic/type-annotation-spacing": "error",
      // Function parentheses spacing rules
      "space-before-function-paren": [
        "error",
        { anonymous: "always", named: "never", asyncArrow: "always" }
      ],
      // Double quotes for consistency (matches JSON)
      "quotes": [ "error", "double", { avoidEscape: true } ],
      // No trailing commas - cleaner diffs aren't worth the risk
      "comma-dangle": "error",
      // 1TBS brace style (opening brace on same line)
      "brace-style": [ "error", "1tbs" ],
      // Spaces inside object braces for readability
      "object-curly-spacing": [ "error", "always" ],
      // Spaces inside array brackets
      "array-bracket-spacing": [
        "warn",
        "always",
        {
          objectsInArrays: true,
          arraysInArrays: false,
          singleValue: true
        }
      ],
      // Consistent key-value spacing in objects
      "key-spacing": [
        "warn",
        { beforeColon: false, afterColon: true, mode: "strict" }
      ],
      // No spaces inside computed properties
      "computed-property-spacing": [ "warn", "never" ],

      // === JavaScript Best Practices ===
      // Disallow var - use const/let instead
      "no-var": "error",
      // Smart equality checks (allows == for null checks)
      "eqeqeq": [ "error", "smart" ],
      // Require hasOwnProperty check in for-in loops
      "guard-for-in": "error",
      // Disallow eval - security risk
      "no-eval": "error",
      // Require radix parameter in parseInt
      "radix": "error",
      // Allow console.log - we use it for logging
      "no-console": "off",
      // Warn on debugger statements
      "no-debugger": "warn",
      // Allow redeclaration (common pattern with Zod: const Schema + type Schema)
      "@typescript-eslint/no-redeclare": "off",
      "no-redeclare": "off"
    }
  },

  // TypeScript-specific refinements
  {
    files: [ "**/*.ts" ],
    rules: {
      // Warn on unused variables, but allow underscore prefix for intentional unused
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ],
      // Don't require explicit return types - TypeScript infers them well
      "@typescript-eslint/explicit-function-return-type": "off"
    }
  }
];

export default config;
