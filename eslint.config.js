// ESLint flat config。
// 关键约束：
// 1) 模块边界（no-restricted-imports）：core/ 只能依赖 types/ 与 utils/；
//    types/ 是零依赖纯类型层。具体实现一律经接口注入（依赖倒置）。
// 2) type-checked 规则全开，禁止 any。
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '**/llm/**', '**/tools/**', '**/storage/**', '**/config/**'],
              message: 'core/ 只能依赖 types/ 与 utils/（依赖倒置：具体实现经接口注入）',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/core/**',
                '**/cli/**',
                '**/llm/**',
                '**/tools/**',
                '**/storage/**',
                '**/config/**',
                '**/utils/**',
              ],
              message: 'types/ 是零依赖纯类型层，禁止反向依赖其他模块',
            },
          ],
        },
      ],
    },
  },
  {
    // 端口（core/ports.ts）为远程存储预留 async 签名，better-sqlite3 是同步实现，
    // 属"同步实现异步端口"的刻意取舍，不逐个内联 disable。
    files: ['src/storage/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['src/cli/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
