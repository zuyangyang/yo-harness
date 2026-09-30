import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// 每个测试后卸载已渲染的组件，避免 DOM 在用例间累积。
afterEach(() => {
  cleanup();
});
