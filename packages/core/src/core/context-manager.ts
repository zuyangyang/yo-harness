/**
 * 上下文管理器 —— 事件流的"模型视图"。
 *
 * 两个职责：
 * 1. 把事件确定性折叠为 ChatMessage[]（与 storage 重放同构，
 *    resume 时 fromEvents 与逐步 push 结果一致）；
 * 2. 估算 token 超出 body 预算时分级裁剪：
 *    阶段 1 省略保留区之外的 tool_result 文本（占位符替换，最早优先）；
 *    阶段 2 丢弃最早的无保留消息组（组 = user 消息 + 其后到下一个
 *    user 前的全部消息；成组丢弃避免产生游离 tool 消息，违反
 *    Provider 的消息结构约束）。
 *
 * 保留区 = 最近 keepRecent 条消息 ∪ 最后一条 user 消息，永不裁剪。
 * 裁剪后仍超预算则 best-effort 返回（交由上层决定报错与否）。
 *
 * build() 是异步的（压缩阶段需要调 LLM），不改变内部状态，可重复调用
 * （AgentLoop 每个 step 调用一次，ContextBuildResult 同时是 context_elided
 * 事件的数据来源）。
 */
import type { AgentEvent } from '../types/events.js';
import type { ChatMessage } from '../types/llm.js';
import { estimateMessageTokens, estimateTokens, TokenCalibrator } from '../utils/tokens.js';
import type { Compressor } from './compressor.js';

/** 输出预留：为模型本次回复保留的空间，不计入 body 预算 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_000;
/** 工具定义 + 系统提示预留 */
export const DEFAULT_TOOLS_SYSTEM_RESERVE_TOKENS = 8_000;
/** body 目标占比：留 20% 余量，吸收估算误差，避免真实上下文超窗 */
export const DEFAULT_BODY_TARGET_RATIO = 0.8;
/** 保留区大小：最近 N 条消息永不裁剪 */
export const DEFAULT_KEEP_RECENT = 6;

export interface ContextManagerConfig {
  /** 模型上下文窗口（tokens） */
  contextWindow: number;
  keepRecent?: number;
  outputReserveTokens?: number;
  toolsSystemReserveTokens?: number;
  /** (0, 1]，预算内目标占比 */
  bodyTargetRatio?: number;
  /** Phase 4: 可选的 token 校准器；注入后估算 × ratio 校正预算 */
  calibrator?: TokenCalibrator;
  /** Phase 4: 校准键（provider + model）；与 calibrator 一起注入 */
  calibratorProvider?: string;
  calibratorModel?: string;
}

export interface ContextBuildResult {
  messages: ChatMessage[];
  /** tool_result 省略条数 + 丢弃消息条数，> 0 时上层产出 context_elided 事件 */
  elidedCount: number;
  freedEstTokens: number;
  /** 裁剪后的估算 tokens */
  estTokens: number;
  /** 本次构建的 body 预算上限 */
  bodyBudgetTokens: number;
  /** Phase 2: 压缩的消息数量（摘要替换） */
  compressedCount: number;
  /** Phase 2: 压缩前估算 tokens */
  compressedBeforeTokens: number;
  /** Phase 2: 压缩后估算 tokens */
  compressedAfterTokens: number;
}

/** tool_result 被省略后的占位文本（保留可追溯性，不保留内容） */
export function toolElidedPlaceholder(
  origChars: number,
  toolName: string,
  callId: string,
): string {
  return `[tool result elided: ${origChars} chars, ${toolName} ${callId}]`;
}

/** 事件 → 消息映射；不产出消息的事件类型返回 undefined */
function eventToMessage(event: AgentEvent): ChatMessage | undefined {
  switch (event.type) {
    case 'user_input':
      return { role: 'user', text: event.content };
    case 'assistant_text':
      return event.toolCalls.length > 0
        ? { role: 'assistant', text: event.text, toolCalls: event.toolCalls }
        : { role: 'assistant', text: event.text };
    case 'tool_result':
      return event.ok
        ? { role: 'tool', callId: event.callId, text: event.content }
        : { role: 'tool', callId: event.callId, text: event.content, isError: true };
    default:
      return undefined;
  }
}

export class ContextManager {
  private readonly messages: ChatMessage[] = [];
  private readonly ests: number[] = [];
  private readonly callIdToToolName = new Map<string, string>();
  private estTotal = 0;

  private readonly keepRecent: number;
  private readonly outputReserveTokens: number;
  private readonly toolsSystemReserveTokens: number;
  private readonly bodyTargetRatio: number;

  /** Phase 2: 可选的压缩器 */
  private compressor: Compressor | undefined;

  /** Phase 4: 可选的 token 校准器（估算 × ratio 校正预算） */
  private readonly calibrator: TokenCalibrator | undefined;
  private readonly calibratorProvider: string | undefined;
  private readonly calibratorModel: string | undefined;

  constructor(readonly config: ContextManagerConfig) {
    this.keepRecent = config.keepRecent ?? DEFAULT_KEEP_RECENT;
    this.outputReserveTokens = config.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
    this.toolsSystemReserveTokens =
      config.toolsSystemReserveTokens ?? DEFAULT_TOOLS_SYSTEM_RESERVE_TOKENS;
    this.bodyTargetRatio = config.bodyTargetRatio ?? DEFAULT_BODY_TARGET_RATIO;
    this.calibrator = config.calibrator;
    this.calibratorProvider = config.calibratorProvider;
    this.calibratorModel = config.calibratorModel;
  }

  /** 按当前模型的校准系数缩放估算值（未注入校准器时原样返回） */
  private scale(tokens: number): number {
    if (
      this.calibrator === undefined ||
      this.calibratorProvider === undefined ||
      this.calibratorModel === undefined
    ) {
      return tokens;
    }
    return Math.ceil(tokens * this.calibrator.ratio(this.calibratorProvider, this.calibratorModel));
  }

  /** Phase 2: 注入压缩器（可选） */
  setCompressor(compressor: Compressor): void {
    this.compressor = compressor;
  }

  /** 事件流重放构建（resume 场景）；与逐步 push 等价 */
  static fromEvents(events: Iterable<AgentEvent>, config: ContextManagerConfig): ContextManager {
    const manager = new ContextManager(config);
    for (const event of events) manager.push(event);
    return manager;
  }

  get size(): number {
    return this.messages.length;
  }

  /** 追加事件；仅消息类事件改变内部状态，其余被忽略 */
  push(event: AgentEvent): void {
    if (event.type === 'assistant_text') {
      for (const call of event.toolCalls) {
        this.callIdToToolName.set(call.callId, call.toolName);
      }
    } else if (event.type === 'tool_call') {
      this.callIdToToolName.set(event.callId, event.toolName);
    }

    const message = eventToMessage(event);
    if (message === undefined) return;
    this.messages.push(message);
    const est = this.scale(estimateMessageTokens(message));
    this.ests.push(est);
    this.estTotal += est;

    // Phase 2: push 新事件时压缩缓存失效（索引偏移变了）
    this.compressor?.clearCache();
  }

  /** body 预算 = (窗口 − 输出预留 − 工具/系统预留) × 目标占比 */
  bodyBudgetTokens(): number {
    const usable =
      this.config.contextWindow - this.outputReserveTokens - this.toolsSystemReserveTokens;
    return Math.max(0, Math.floor(usable * this.bodyTargetRatio));
  }

  async build(): Promise<ContextBuildResult> {
    const n = this.messages.length;
    const reserved = this.reservedIndices();
    const bodyBudget = this.bodyBudgetTokens();

    // 工作副本：build() 不改变 push 累积的状态
    let workingMessages = this.messages.slice();
    let ests = this.ests.slice();
    const elided = new Map<number, string>();
    const kept: boolean[] = new Array<boolean>(n).fill(true);
    let estTotal = this.estTotal;
    let elidedCount = 0;

    // Phase 2: 压缩统计
    let compressedCount = 0;
    let compressedBeforeTokens = 0;
    let compressedAfterTokens = 0;

    // Phase 2: 如果配置了压缩器且超阈值，先尝试压缩
    if (this.compressor !== undefined) {
      const compressed = await this.compressor.compress(workingMessages, bodyBudget, this.callIdToToolName);
      if (compressed.compressedCount > 0) {
        compressedCount = compressed.compressedCount;
        compressedBeforeTokens = compressed.beforeTokens;
        compressedAfterTokens = compressed.afterTokens;
        workingMessages = compressed.messages;
        // 重新计算 ests 和 estTotal
        ests = workingMessages.map((m) => this.scale(estimateMessageTokens(m)));
        estTotal = ests.reduce((sum, est) => sum + est, 0);
      }
    }

    // 阶段 1：省略保留区之外的 tool_result 文本，最早优先，达标即停
    if (estTotal > bodyBudget) {
      for (let i = 0; i < workingMessages.length; i++) {
        if (estTotal <= bodyBudget) break;
        const message = workingMessages[i];
        if (message?.role !== 'tool' || reserved.has(i)) continue;
        const placeholder = toolElidedPlaceholder(
          message.text.length,
          this.callIdToToolName.get(message.callId) ?? 'unknown',
          message.callId,
        );
        const newEst = this.scale(estimateTokens(placeholder));
        if (newEst >= (ests[i] ?? 0)) continue; // 占位符不小于原文，省略无益
        estTotal -= (ests[i] ?? 0) - newEst;
        ests[i] = newEst;
        elided.set(i, placeholder);
        elidedCount += 1;
      }
    }

    // 阶段 2：丢弃最早的无保留消息组，达标即停；仍超则 best-effort 返回
    if (estTotal > bodyBudget) {
      for (const group of this.messageGroups(workingMessages)) {
        if (estTotal <= bodyBudget) break;
        if (group.some((i) => reserved.has(i))) continue;
        for (const i of group) {
          kept[i] = false;
          estTotal -= ests[i] ?? 0;
        }
        elidedCount += group.length;
      }
    }

    const messages: ChatMessage[] = [];
    for (let i = 0; i < workingMessages.length; i++) {
      if (!kept[i]) continue;
      const message = workingMessages[i];
      if (message === undefined) continue;
      const placeholder = elided.get(i);
      messages.push(placeholder === undefined ? message : { ...message, text: placeholder });
    }

    return {
      messages,
      elidedCount,
      freedEstTokens: this.estTotal - estTotal,
      estTokens: estTotal,
      bodyBudgetTokens: bodyBudget,
      compressedCount,
      compressedBeforeTokens,
      compressedAfterTokens,
    };
  }

  /** 保留区：最近 keepRecent 条 + 最后一条 user 消息 */
  private reservedIndices(): Set<number> {
    const n = this.messages.length;
    const reserved = new Set<number>();
    for (let i = Math.max(0, n - this.keepRecent); i < n; i++) reserved.add(i);
    for (let i = n - 1; i >= 0; i--) {
      if (this.messages[i]?.role === 'user') {
        reserved.add(i);
        break;
      }
    }
    return reserved;
  }

  /** 消息组划分：每组以 user 消息开头，含其后直到下一个 user 前的全部消息 */
  private messageGroups(msgs?: ChatMessage[]): number[][] {
    const messages = msgs ?? this.messages;
    const groups: number[][] = [];
    let current: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === 'user') {
        if (current.length > 0) groups.push(current);
        current = [i];
      } else {
        current.push(i);
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }
}
