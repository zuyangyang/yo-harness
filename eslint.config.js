// ESLint flat config（monorepo 版本）。
// 关键约束：
// 1) 模块边界（no-restricted-imports）：core/ 只能依赖 types/ 与 utils/；
//    types/ 是零依赖纯类型层。具体实现一律经接口注入（依赖倒置）。
// 2) type-checked 规则全开，禁止 any。
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'packages/web/dist/**'] },
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
    files: ['packages/core/src/core/**/*.ts'],
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
    files: ['packages/core/src/types/**/*.ts'],
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
    files: ['packages/core/src/storage/**/*.ts', 'packages/server/src/storage/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['packages/cli/src/cli/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['packages/*/tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // 测试桩/模拟对象常见噪音：空实现、无 await 的 async 桩、any 类型、解绑方法
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
