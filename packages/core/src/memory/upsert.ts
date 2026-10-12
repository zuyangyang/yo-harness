/**
 * key 确定性 upsert。
 *
 * 稳定槽位（如 profile.name / preference.language / env.db_path）在语义上
 * 只应存在一条记忆。命中 key 时直接覆盖内容——不依赖 LLM 判断关系，
 * 也不会产生重复条目。这是"自动更新而非全量 append"的确定性骨架。
 */
import type { Memory, MemoryCreateInput, MemoryUpdatePatch } from '../types/memory.js';

/** upsert 所需的最小存储能力（便于 SQLite / Postgres 共用） */
export interface KeyedMemoryStore {
  getByKey(key: string): Promise<Memory | undefined>;
  create(input: MemoryCreateInput): Promise<Memory>;
  update(id: string, patch: MemoryUpdatePatch): Promise<Memory | undefined>;
}

/**
 * 按 key 写入：存在则更新同一行，不存在则创建。
 *
 * 更新时复位 status='active' 并清空 validTo / supersededBy：
 * keyed 槽位代表「当前最新事实」，历史上被取代的版本不应继续压制它。
 */
export async function upsertMemoryByKey(
  store: KeyedMemoryStore,
  input: MemoryCreateInput & { key: string },
): Promise<{ memory: Memory; created: boolean }> {
  const existing = await store.getByKey(input.key);
  if (existing === undefined) {
    const memory = await store.create(input);
    return { memory, created: true };
  }

  const patch: MemoryUpdatePatch = {
    title: input.title,
    content: input.content,
    category: input.category,
    description: input.description,
    keywords: input.keywords,
    status: 'active',
    // keyed 事实被新值整体替换，TTL 也跟着换（未提供即视为永久）
    expiresAt: input.expiresAt ?? null,
    validTo: null,
    supersededBy: null,
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(input.durability !== undefined ? { durability: input.durability } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
  };

  const memory = await store.update(existing.id, patch);
  if (memory === undefined) {
    // 理论不可达（刚读到 existing）；退化为创建，避免静默丢数据
    const created = await store.create(input);
    return { memory: created, created: true };
  }
  return { memory, created: false };
}
