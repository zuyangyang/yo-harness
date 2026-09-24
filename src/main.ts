#!/usr/bin/env node
/**
 * yo-harness CLI 入口（§6.8）。
 * commander 只负责参数解析与帮助文本，全部装配在 cli/runtime.ts。
 */
import { createRequire } from 'node:module';
import { Command } from 'commander';

import { runCli, runResume } from './cli/runtime.js';
import { FatalError } from './types/errors.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/** commander 解析结果（undefined = 未提供） */
interface ParsedOptions {
  model?: string;
  print?: string;
  provider?: string;
  fake?: boolean;
  yolo?: boolean;
}

const program = new Command();

program
  .name('yo')
  .description('yo-harness — 本地优先的个人智能体（local-first personal agent harness）')
  .version(version)
  // 子命令与主命令共享 --fake/--yolo 等选项名；
  // enablePositionalOptions 确保子命令的选项不被父命令吞掉
  .enablePositionalOptions()
  .option('-m, --model <model>', '覆盖生效 provider 的模型（优先级最高）')
  .option('-p, --print <text>', '非交互模式：发送一条消息，打印最终回复后退出')
  .option('--provider <name>', 'LLM provider：anthropic | openai-compat')
  .option('--fake', '离线脚本化 provider（YO_FAKE_SCRIPT，缺省一句问候）')
  .option('--yolo', '本次运行全量放行审批（危险，仅限可信沙箱）')
  // 返回 promise：commander 的 parseAsync 会等待 action 结果，
  // runCli 的 FatalError 因此能进统一的 catch（干净的消息 + exit 1）
  .action((options: ParsedOptions) =>
    runCli({
      provider: options.provider,
      model: options.model,
      yolo: options.yolo === true,
      fake: options.fake === true,
      print: options.print,
    }),
  );

program
  .command('resume')
  .description('恢复历史会话（无参数弹选择器，传 id 直接恢复）')
  .argument('[id]', '会话 id（完整 UUID 或前 8 字符前缀）')
  .option('-p, --print <text>', '非交互模式：发送一条消息，打印最终回复后退出')
  .option('--provider <name>', 'LLM provider：anthropic | openai-compat')
  .option('-m, --model <model>', '覆盖生效 provider 的模型')
  .option('--fake', '离线脚本化 provider')
  .option('--yolo', '本次运行全量放行审批')
  .action((id: string | undefined, options: ParsedOptions) =>
    runResume({
      sessionId: id,
      provider: options.provider,
      model: options.model,
      yolo: options.yolo === true,
      fake: options.fake === true,
      print: options.print,
    }),
  );

program.parseAsync().catch((err: unknown) => {
  // FatalError 自带修复指引，只打 message；意外错误保留完整形态便于排查
  if (err instanceof FatalError) {
    console.error(`yo: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
