import tseslint from "typescript-eslint";

// Flat config. The parser is attached via `extends: [tseslint.configs.base]`
// rather than `parser: tseslint.parser` — that property write is `any`-typed
// and the community no-unsafe-assignment scan flags it.
// `import.meta.dirname` is `string | undefined` under NodeNext, and
// `fileURLToPath(import.meta.url)` lands as `any` when this file is scanned
// without @types/node — both trip the same scan. `String(...)` returns a
// typed `string`, so the assignment is safe.
const tsconfigRootDir = String(import.meta.dirname ?? ".");

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    linterOptions: {
      // src keeps disables for rules the community scanner enables (require()).
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
);
