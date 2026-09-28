/**
 * LLM 消息模型 —— Provider 无关。
 *
 * 统一消息格式是我们自己的；anthropic / openai-compat 适配器负责
 * 双向转换（这是最容易出错的地方，由契约测试覆盖）。
 */
import type { ToolCall } from './events.js';
import type { ToolSpec } from './tools.js';

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; text: string; isError?: boolean };

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ChatOptions {
  /** 流式文本增量（仅用于 UI 实时渲染，最终以 ChatResponse.text 为准） */
  onTextDelta?: (delta: string) => void;
}

/** Provider 端口：anthropic / openai-compat / fake 都实现它 */
export interface LLMClient {
  readonly name: string;
  chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse>;
}
