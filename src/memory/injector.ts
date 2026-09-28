/**
 * 记忆注入器：把语义记忆格式化为 system prompt 片段。
 *
 * Phase 3 策略：全量注入所有 active 记忆（按类别分组）。
 * 预期记忆数量 < 200，token 开销 ~2k，在可接受范围内。
 */
import type { Memory } from '../types/memory.js';
import type { MemoryStore } from '../core/ports.js';

export class MemoryInjector {
  constructor(private readonly store: MemoryStore) {}

  /**
   * 生成 system prompt 的记忆片段。
   * 无记忆时返回空字符串。
   */
  async inject(): Promise<string> {
    const memories = await this.store.listActive();
    if (memories.length === 0) return '';

    const grouped = this.groupByCategory(memories);
    const sections: string[] = ['<semantic-memory>'];

    for (const [category, items] of Object.entries(grouped)) {
      sections.push(`\n## ${this.categoryLabel(category)}`);
      for (const m of items) {
        sections.push(`- **${m.title}**: ${m.content}`);
      }
    }

    sections.push('</semantic-memory>');
    return sections.join('\n');
  }

  private groupByCategory(memories: Memory[]): Record<string, Memory[]> {
    const groups: Record<string, Memory[]> = {};
    for (const m of memories) {
      (groups[m.category] ??= []).push(m);
    }
    return groups;
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
