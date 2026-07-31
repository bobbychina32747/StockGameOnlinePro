module.exports = {
  root: true,
  env: { node: true, es2022: true },
  extends: ['eslint:recommended'],
  parserOptions: { ecmaVersion: 'latest' },
  rules: {
    'no-unused-vars': 'warn',
    'no-console': 'off',
  },
  overrides: [
    {
      files: ['frontend/**/*.{ts,tsx}'],
      parser: '@typescript-eslint/parser',
      rules: { '@typescript-eslint/no-explicit-any': 'warn' },
    },
  ],
};
