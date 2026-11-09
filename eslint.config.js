import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'cdk.out/', '.serverless/', 'coverage/', '.superpowers/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
