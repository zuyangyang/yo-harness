#!/usr/bin/env node
/**
 * yo-harness CLI 入口（§6.8）。
 * commander 只负责参数解析与帮助文本，全部装配在 cli/runtime.ts。
 */
import { createRequire } from 'node:module';
import { Command } from 'commander';

import { runCli, runResume } from './cli/runtime.js';
import { startDaemon } from './daemon/daemon-main.js';
import { DaemonApiClient } from './daemon/daemon-api.js';
import { FatalError } from './types/errors.js';
import { yoHome } from './utils/paths.js';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/** commander 解析结果（undefined = 未提供） */
interface ParsedOptions {
  model?: string;
  print?: string;
  plan?: string;
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
  .option('--plan <description>', '规划模式：先探索再产出执行计划')
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
      plan: options.plan,
    }),
  );

program
  .command('resume')
  .description('恢复历史会话（无参数弹选择器，传 id 直接恢复）')
  .argument('[id]', '会话 id（完整 UUID 或前 8 字符前缀）')
  .option('-p, --print <text>', '非交互模式：发送一条消息，打印最终回复后退出')
  .option('--plan <description>', '规划模式：先探索再产出执行计划')
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
      plan: options.plan,
    }),
  );

// ─── Phase 3: daemon 子命令 ───

program
  .command('daemon')
  .description('启动 daemon 进程（后台任务调度器）')
  .action(async () => {
    await startDaemon();
  });

program
  .command('daemon-stop')
  .description('停止 daemon 进程')
  .action(async () => {
    const client = new DaemonApiClient({ socketPath: join(yoHome(), 'daemon.sock') });
    try {
      await client.stopDaemon();
      console.log('daemon stopped');
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`yo: ${err.message}`);
      } else {
        console.error(err);
      }
      process.exit(1);
    }
  });

program
  .command('bg')
  .description('提交后台任务（daemon 自动启动）')
  .argument('<prompt>', '任务描述')
  .action(async (prompt: string) => {
    const client = new DaemonApiClient({ socketPath: join(yoHome(), 'daemon.sock') });
    try {
      const result = await client.startTask({ prompt, cwd: process.cwd(), model: 'auto' });
      console.log(`task submitted: ${result.taskId}`);
      console.log(`  session: ${result.sessionId}`);
      console.log(`  check status: yo tasks`);
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`yo: ${err.message}`);
      } else {
        console.error(err);
      }
      process.exit(1);
    }
  });

program
  .command('tasks')
  .description('列出后台任务')
  .option('-n, --limit <n>', '最大显示数量', '20')
  .action(async (options: { limit: string }) => {
    const client = new DaemonApiClient({ socketPath: join(yoHome(), 'daemon.sock') });
    try {
      const tasks = await client.listTasks(Number(options.limit));
      if (tasks.length === 0) {
        console.log('no tasks');
        return;
      }
      for (const task of tasks) {
        const status = task.status.padEnd(10);
        const id = task.id.slice(0, 8);
        const desc = task.description.slice(0, 50);
        console.log(`${id}  ${status}  ${desc}`);
      }
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`yo: ${err.message}`);
      } else {
        console.error(err);
      }
      process.exit(1);
    }
  });

program
  .command('task')
  .description('查看任务详情')
  .argument('<id>', '任务 id')
  .action(async (id: string) => {
    const client = new DaemonApiClient({ socketPath: join(yoHome(), 'daemon.sock') });
    try {
      const task = await client.getTask(id);
      console.log(`Task: ${task.id}`);
      console.log(`Status: ${task.status}`);
      console.log(`Description: ${task.description}`);
      console.log(`Model: ${task.model}`);
      console.log(`Created: ${task.createdAt}`);
      if (task.completedAt !== null) console.log(`Completed: ${task.completedAt}`);
      if (task.endReason !== null) console.log(`End reason: ${task.endReason}`);
      if (task.summary !== null) console.log(`Summary: ${task.summary}`);
      if (task.errorMessage !== null) console.log(`Error: ${task.errorMessage}`);
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`yo: ${err.message}`);
      } else {
        console.error(err);
      }
      process.exit(1);
    }
  });

program
  .command('task-cancel')
  .description('取消任务')
  .argument('<id>', '任务 id')
  .action(async (id: string) => {
    const client = new DaemonApiClient({ socketPath: join(yoHome(), 'daemon.sock') });
    try {
      await client.cancelTask(id);
      console.log(`task ${id} cancelled`);
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`yo: ${err.message}`);
      } else {
        console.error(err);
      }
      process.exit(1);
    }
  });

program.parseAsync().catch((err: unknown) => {
  // FatalError 自带修复指引，只打 message；意外错误保留完整形态便于排查
  if (err instanceof FatalError) {
    console.error(`yo: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
