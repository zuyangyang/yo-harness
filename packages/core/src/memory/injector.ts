/**
 * 记忆注入器：把语义记忆格式化为 system prompt 片段。
 *
 * 三种取用策略：
 * - all：全量 active（按创建时间倒序），带 maxItems / maxTokens 上限；
 * - relevant：用当前用户输入走 store.search 做 FTS 检索；
 * - ranked（默认推荐）：在 active 之上按「时间衰减 + 重要度 + 词面相关度」打分排序，
 *   pinned 记忆永远优先注入。
 *
 * 注入后会对实际进入 prompt 的记忆 touch 一次（last_accessed_at / access_count），
 * 喂给衰减与后续的容量淘汰——这决定了「更高效」：越常用的记忆越不容易被挤掉。
 */
import { estimateTokens } from '../utils/tokens.js';
import type { Memory, MemoryCategory } from '../types/memory.js';
import type {
  MemoryInjection,
  MemoryInjectionContext,
  MemoryInjectionProvider,
  MemoryStore,
} from '../core/ports.js';

export type MemoryInjectMode = 'all' | 'relevant' | 'ranked';

export interface MemoryScoreWeights {
  /** 时间衰减项权重 */
  recency: number;
  /** 重要度项权重 */
  importance: number;
  /** 词面相关度项权重 */
  relevance: number;
}

export interface MemoryInjectorOptions {
  /** 最多注入条数（默认 50） */
  maxItems?: number;
  /** 注入片段 token 预算上限（默认 2000，估算） */
  maxTokens?: number;
  /** 取用策略（默认 ranked） */
  mode?: MemoryInjectMode;
  /** ranked 模式的时间衰减半衰期（天，默认 30） */
  decayHalfLifeDays?: number;
  /** ranked 模式打分权重（默认全 1） */
  weights?: MemoryScoreWeights;
}

/** 类别输出顺序固定，保证注入内容可复现 */
const CATEGORY_ORDER: MemoryCategory[] = [
  'preference',
  'environment',
  'project_knowledge',
  'general',
];

const DEFAULT_WEIGHTS: MemoryScoreWeights = { recency: 1, importance: 1, relevance: 1 };
const DEFAULT_HALF_LIFE_DAYS = 30;
/** 衰减下限/上限：老记忆仍有机会被召回，但也不会无限放大（照搬 Mem0 Decay 的 0.3 下限） */
const MIN_RETENTION = 0.3;
const MAX_RETENTION = 1.5;
/** access_count 对记忆强度的增益上限 */
const ACCESS_BOOST_CAP = 20;

export class MemoryInjector implements MemoryInjectionProvider {
  private readonly maxItems: number;
  private readonly maxTokens: number;
  private readonly mode: MemoryInjectMode;
  private readonly decayHalfLifeDays: number;
  private readonly weights: MemoryScoreWeights;

  constructor(
    private readonly store: MemoryStore,
    options: MemoryInjectorOptions = {},
  ) {
    this.maxItems = options.maxItems ?? 50;
    this.maxTokens = options.maxTokens ?? 2000;
    this.mode = options.mode ?? 'ranked';
    this.decayHalfLifeDays = options.decayHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
  }

  /**
   * 生成 system prompt 的记忆片段与元信息。
   * 无可用记忆时返回 undefined。
   */
  async buildInjection(context: MemoryInjectionContext): Promise<MemoryInjection | undefined> {
    const selected = await this.select(context);
    if (selected.length === 0) return undefined;

    const now = Date.now();
    const rendered = this.render(selected);
    if (rendered.text === '') return undefined;

    // 只对真正进入 prompt 的记忆记一次「召回」
    if (rendered.includedIds.length > 0) {
      await this.store.touch(rendered.includedIds, new Date(now).toISOString());
    }

    return {
      text: rendered.text,
      memoryIds: rendered.includedIds,
      count: rendered.includedIds.length,
    };
  }

  /**
   * 兼容旧调用方：只返回文本；无记忆时返回空字符串。
   */
  async inject(): Promise<string> {
    const injection = await this.buildInjection({ userInput: '' });
    return injection === undefined ? '' : injection.text;
  }

  private async select(context: MemoryInjectionContext): Promise<Memory[]> {
    if (this.mode === 'relevant' && context.userInput.trim().length > 0) {
      return this.store.search(context.userInput, { limit: this.maxItems });
    }

    const all = await this.store.listActive();
    if (this.mode !== 'ranked') return all.slice(0, this.maxItems);

    return this.rank(all, context.userInput);
  }

  /** pinned 优先；其余按 score 降序补齐到 maxItems */
  private rank(memories: Memory[], userInput: string): Memory[] {
    const now = Date.now();
    const pinned = memories.filter((m) => m.pinned);
    const rest = memories
      .filter((m) => !m.pinned)
      .map((m) => ({ memory: m, score: this.score(m, userInput, now) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.memory);

    const remaining = Math.max(0, this.maxItems - pinned.length);
    return [...pinned, ...rest.slice(0, remaining)];
  }

  private score(memory: Memory, userInput: string, now: number): number {
    const retention = recencyRetention(memory, now, this.decayHalfLifeDays);
    const importance = clamp01(memory.importance / 10);
    const relevance = lexicalRelevance(memory, userInput);
    return (
      this.weights.recency * retention +
      this.weights.importance * importance +
      this.weights.relevance * relevance
    );
  }

  private render(memories: Memory[]): { text: string; includedIds: string[] } {
    const groups = new Map<MemoryCategory, Memory[]>();
    for (const category of CATEGORY_ORDER) groups.set(category, []);
    for (const m of memories) groups.get(m.category)?.push(m);

    const sections: string[] = ['<semantic-memory>'];
    const includedIds: string[] = [];
    let usedTokens = 0;

    for (const category of CATEGORY_ORDER) {
      const items = groups.get(category) ?? [];
      if (items.length === 0) continue;
      const lines: string[] = [];
      for (const m of items) {
        const line = '- **' + m.title + '**: ' + m.content;
        const cost = estimateTokens(line);
        // 至少注入 1 条，之后按预算截断
        if (includedIds.length > 0 && usedTokens + cost > this.maxTokens) break;
        usedTokens += cost;
        includedIds.push(m.id);
        lines.push(line);
      }
      if (lines.length > 0) {
        sections.push('\n## ' + this.categoryLabel(category));
        sections.push(...lines);
      }
    }

    sections.push('</semantic-memory>');
    if (includedIds.length === 0) return { text: '', includedIds };
    return { text: sections.join('\n'), includedIds };
  }

  private categoryLabel(category: string): string {
    const labels: Record<string, string> = {
      preference: 'User Preferences',
      environment: 'Environment Facts',
      project_knowledge: 'Project Knowledge',
      general: 'General',
    };
    return labels[category] ?? category;
  }
}

/** 时间衰减 + 召回增益，夹在 [0.3, 1.5] 之间 */
function recencyRetention(memory: Memory, now: number, halfLifeDays: number): number {
  const base = Date.parse(memory.lastAccessedAt ?? memory.createdAt);
  const days = Number.isNaN(base) ? 0 : Math.max(0, (now - base) / 86_400_000);
  const recency = Math.pow(0.5, days / Math.max(1, halfLifeDays));
  const boost = 1 + Math.min(memory.accessCount, ACCESS_BOOST_CAP) / ACCESS_BOOST_CAP;
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, recency * boost));
}

/** 词面相关度：用户输入 token 在记忆文本中的命中比例（0-1） */
function lexicalRelevance(memory: Memory, userInput: string): number {
  const query = tokenize(userInput);
  if (query.size === 0) return 0;
  const text = tokenize(
    [memory.title, memory.description, memory.keywords.join(' '), memory.content].join(' '),
  );
  if (text.size === 0) return 0;
  let hits = 0;
  for (const token of query) if (text.has(token)) hits += 1;
  return hits / query.size;
}

/** 小写分词：保留字母/数字/下划线/点，丢弃 1 字符噪声 */
function tokenize(input: string): Set<string> {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.]+/u)
    .filter((token) => token.length >= 2);
  return new Set(tokens);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
