'use strict';
// ESLint flat config（v0.46）：真实 ESLint + 安全插件，替代只用正则的语法扫描。
// 规则取舍：security/detect-object-injection 与 non-literal-fs-filename 在本项目噪声过大，
// 关闭；child-process / eval 相关保持开启。
const js = require('@eslint/js');
const security = require('eslint-plugin-security');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'data/**',
      'coverage/**',
      'test/fixtures/**',
      'e2e/fixtures/**',
    ],
  },
  js.configs.recommended,
  security.configs.recommended,
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      // 本项目的文件路径来自受控目录/校验后的 id，不适用该规则
      'security/detect-non-literal-fs-filename': 'off',
      // 大量对象索引来自受控字典，误报过多
      'security/detect-object-injection': 'off',
      'security/detect-child-process': 'warn',
      'security/detect-eval-with-expression': 'error',
    },
  },
  {
    files: ['public/**/*.js', 'e2e/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, SFC1: 'readonly' },
    },
  },
];
