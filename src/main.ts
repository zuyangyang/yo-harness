#!/usr/bin/env node
/**
 * yo-harness CLI 入口。
 * 当前为 Step 0 脚手架：仅注册命令骨架，随实现推进逐步装配完整运行时。
 */
import { createRequire } from 'node:module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('yo')
  .description('yo-harness — 本地优先的个人智能体（local-first personal agent harness）')
  .version(version);

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
