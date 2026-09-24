/**
 * 手动冒烟脚本（不进 CI、不进测试）：对真实 API 各发一次请求，
 * 验证双适配器的非流式 / 流式 / 工具调用三条通路。
 *
 * 用法：
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/ping.ts anthropic
 *   OPENAI_API_KEY=sk-... npx tsx examples/ping.ts openai          # 官方
 *   OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.deepseek.com npx tsx examples/ping.ts openai
 *   npx tsx examples/ping.ts                                        # 两个都跑（缺 key 的跳过）
 *
 * 模型可用 YO_MODEL 覆盖（默认 anthropic=claude-sonnet-4-5，openai=gpt-4o-mini）。
 * 密钥只从环境变量读取（SDK 行为），绝不写进代码 / 日志 / 事件流。
 */
import { AnthropicLLMClient } from '../src/llm/providers/anthropic.js';
import { OpenAICompatLLMClient } from '../src/llm/providers/openai-compat.js';
import type { LLMClient } from '../src/types/llm.js';

const SYSTEM = 'You are yo-harness ping, a smoke-test assistant. Answer in one short sentence.';

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
} as const;

function line(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label} ${detail}\n`);
}

async function pingProvider(label: string, model: string, client: LLMClient): Promise<boolean> {
  process.stdout.write(`\n[${label}] model=${model}\n`);
  let allOk = true;

  // 1. 非流式基本对话
  try {
    const res = await client.chat({
      system: SYSTEM,
      messages: [{ role: 'user', text: 'Reply with exactly: pong' }],
      tools: [],
      maxTokens: 64,
    });
    const ok = res.stopReason === 'end_turn' && res.text.length > 0;
    allOk &&= ok;
    line('basic   ', ok, `stop=${res.stopReason} usage=${res.usage.inputTokens}/${res.usage.outputTokens} text=${JSON.stringify(res.text.slice(0, 60))}`);
  } catch (err) {
    allOk = false;
    line('basic   ', false, err instanceof Error ? err.message : String(err));
  }

  // 2. 流式：delta 拼接须等于最终文本
  try {
    const deltas: string[] = [];
    const res = await client.chat(
      {
        system: SYSTEM,
        messages: [{ role: 'user', text: 'Count from one to five.' }],
        tools: [],
        maxTokens: 128,
      },
      { onTextDelta: (d) => deltas.push(d) },
    );
    const ok = deltas.length >= 1 && deltas.join('') === res.text;
    allOk &&= ok;
    line('stream  ', ok, `deltas=${deltas.length} joined=${deltas.join('').length}ch final=${res.text.length}ch usage=${res.usage.inputTokens}/${res.usage.outputTokens}`);
  } catch (err) {
    allOk = false;
    line('stream  ', false, err instanceof Error ? err.message : String(err));
  }

  // 3. 工具调用：模型应请求 get_weather，适配器应解析出 callId/名称/参数
  try {
    const res = await client.chat({
      system: SYSTEM,
      messages: [{ role: 'user', text: 'What is the weather in Beijing? You must call the get_weather tool.' }],
      tools: [WEATHER_TOOL],
      maxTokens: 256,
    });
    const call = res.toolCalls[0];
    const ok = res.stopReason === 'tool_use' && call?.toolName === 'get_weather';
    allOk &&= ok;
    line('tool_use', ok, call ? `callId=${call.callId} args=${JSON.stringify(call.args)}` : `stop=${res.stopReason} calls=${res.toolCalls.length}`);
  } catch (err) {
    allOk = false;
    line('tool_use', false, err instanceof Error ? err.message : String(err));
  }

  return allOk;
}

function anthropicTarget(): { model: string; client: LLMClient | undefined } {
  const model = process.env.YO_MODEL ?? 'claude-sonnet-4-5';
  if (process.env.ANTHROPIC_API_KEY === undefined) return { model, client: undefined };
  return { model, client: AnthropicLLMClient.create({ model }) };
}

function openaiTarget(): { model: string; client: LLMClient | undefined } {
  const model = process.env.YO_MODEL ?? 'gpt-4o-mini';
  if (process.env.OPENAI_API_KEY === undefined) return { model, client: undefined };
  // OPENAI_BASE_URL 由 SDK 自动读取（DeepSeek / vLLM / 网关等兼容端点）
  return { model, client: OpenAICompatLLMClient.create({ model }) };
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all';
  const targets: { label: string; model: string; client: LLMClient | undefined }[] = [];

  if (which === 'all' || which === 'anthropic') {
    targets.push({ label: 'anthropic', ...anthropicTarget() });
  }
  if (which === 'all' || which === 'openai') {
    targets.push({ label: 'openai', ...openaiTarget() });
  }

  if (targets.length === 0 || targets.every((t) => t.client === undefined)) {
    process.stdout.write('no provider to ping (missing API key env). skipped.\n');
    return;
  }

  let allOk = true;
  for (const t of targets) {
    if (t.client === undefined) {
      process.stdout.write(`\n[${t.label}] no API key, skipped\n`);
      continue;
    }
    allOk &&= await pingProvider(t.label, t.model, t.client);
  }

  process.stdout.write(`\n${allOk ? 'ALL OK' : 'FAILED'}\n`);
  process.exitCode = allOk ? 0 : 1;
}

void main();
