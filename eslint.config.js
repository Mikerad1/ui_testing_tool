import tsParser from '@typescript-eslint/parser';
export default [{
  files: ['src/**/*.ts', 'tests/**/*.ts'],
  languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
  rules: { 'no-undef': 'off', 'no-unused-vars': 'off' }
}];
