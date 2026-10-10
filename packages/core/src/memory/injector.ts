/**
 * 记忆注入器：把语义记忆格式化为 system prompt 片段。
 *
 * 默认策略：全量注入所有 active 记忆（按类别分组），带 maxItems / maxTokens 上限。
 * 预留 relevant 模式：用当前用户输入走 store.search 检索。
 */
import { estimateTokens } from '../utils/tokens.js';
import type { Memory, MemoryCategory } from '../types/memory.js';
import type {
  MemoryInjection,
  MemoryInjectionContext,
  MemoryInjectionProvider,
  MemoryStore,
} from '../core/ports.js';

export interface MemoryInjectorOptions {
  /** 最多注入条数（默认 50） */
  maxItems?: number;
  /** 注入片段 token 预算上限（默认 2000，估算） */
  maxTokens?: number;
  /** all = 全量 active；relevant = 按用户输入 FTS 检索（默认 all） */
  mode?: 'all' | 'relevant';
}

/** 类别输出顺序固定，保证注入内容可复现 */
const CATEGORY_ORDER: MemoryCategory[] = [
  'preference',
  'environment',
  'project_knowledge',
  'general',
];

export class MemoryInjector implements MemoryInjectionProvider {
  private readonly maxItems: number;
  private readonly maxTokens: number;
  private readonly mode: 'all' | 'relevant';

  constructor(
    private readonly store: MemoryStore,
    options: MemoryInjectorOptions = {},
  ) {
    this.maxItems = options.maxItems ?? 50;
    this.maxTokens = options.maxTokens ?? 2000;
    this.mode = options.mode ?? 'all';
  }

  /**
   * 生成 system prompt 的记忆片段与元信息。
   * 无可用记忆时返回 undefined。
   */
  async buildInjection(context: MemoryInjectionContext): Promise<MemoryInjection | undefined> {
    const memories = await this.select(context);
    if (memories.length === 0) return undefined;
    const text = this.render(memories);
    if (text === '') return undefined;
    return { text, memoryIds: memories.map((m) => m.id), count: memories.length };
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
    return all.slice(0, this.maxItems);
  }

  private render(memories: Memory[]): string {
    const groups = new Map<MemoryCategory, Memory[]>();
    for (const category of CATEGORY_ORDER) groups.set(category, []);
    for (const m of memories) groups.get(m.category)?.push(m);

    const sections: string[] = ['<semantic-memory>'];
    let usedTokens = 0;
    let included = 0;

    for (const category of CATEGORY_ORDER) {
      const items = groups.get(category) ?? [];
      if (items.length === 0) continue;
      const lines: string[] = [];
      for (const m of items) {
        const line = '- **' + m.title + '**: ' + m.content;
        const cost = estimateTokens(line);
        // 至少注入 1 条，之后按预算截断
        if (included > 0 && usedTokens + cost > this.maxTokens) break;
        usedTokens += cost;
        included += 1;
        lines.push(line);
      }
      if (lines.length > 0) {
        sections.push('\n## ' + this.categoryLabel(category));
        sections.push(...lines);
      }
    }

    sections.push('</semantic-memory>');
    return sections.join('\n');
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
