import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,

    /*************** Prettier plugin (reports formatting as errors) *******/
    {
        plugins: { prettier: prettierPlugin },
        rules: {
            "prettier/prettier": "error",
        },
    },

    /***************** TypeScript rules *******************/
    {
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            "@typescript-eslint/no-unused-vars": "error",
            "@typescript-eslint/no-explicit-any": "error",
        },
    },
    eslintConfigPrettier,
);
