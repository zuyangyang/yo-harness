/**
 * 语义记忆数据模型。
 *
 * 记忆 = 跨会话持久化的结构化知识（用户偏好 / 环境事实 / 项目约定）。
 * 由 MemoryExtractor 从对话中自动提取，或用户手动添加。
 * 存取边界用 zod schema 校验。
 *
 * v9 起引入智能记忆元数据：重要度、耐久性、时效与衰减、双时态取代关系。
 */
import { z } from 'zod';

export const MemoryCategorySchema = z.enum([
  'preference',
  'environment',
  'project_knowledge',
  'general',
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

/**
 * 记忆状态。
 *
 * - active      当前可信，参与注入
 * - superseded  被更新的事实取代（矛盾），保留可追溯
 * - merged      被近重复合并进 canonical 记忆，保留可追溯
 * - expired     已过期（正常情况下只靠 expires_at 过滤，不写状态）
 * - archived    用户/容量淘汰归档
 */
export const MemoryStatusSchema = z.enum([
  'active',
  'superseded',
  'merged',
  'expired',
  'archived',
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/** durable 不参与过期与衰减；ephemeral 按 TTL 过期 */
export const MemoryDurabilitySchema = z.enum(['durable', 'ephemeral']);
export type MemoryDurability = z.infer<typeof MemoryDurabilitySchema>;

export interface Memory {
  id: string;
  title: string;
  content: string;
  category: MemoryCategory;
  /** 一句话描述（用于检索匹配） */
  description: string;
  keywords: string[];
  status: MemoryStatus;
  /** 创建来源会话 ID（可追溯） */
  sourceSessionId?: string;
  /** 稳定槽位（如 profile.name）；非空时唯一 → 确定性 upsert */
  key?: string;
  /** 1-10 重要度，写入时打分（Generative Agents 式），用于价值闸门与排序 */
  importance: number;
  durability: MemoryDurability;
  /** 0-1 置信度 */
  confidence: number;
  /** 1 = 每 turn 必注入，免疫过期与衰减 */
  pinned: boolean;
  /** 过期时间（ISO）；undefined = 永久。语义是隐藏不是删除 */
  expiresAt?: string;
  /** 双时态：事实在世界中开始为真的时间 */
  validFrom?: string;
  /** 双时态：事实在世界中结束为真的时间 */
  validTo?: string;
  /** 被哪条记忆取代（只失效不删除） */
  supersededBy?: string;
  /** 最近一次被注入的时间，用于衰减 */
  lastAccessedAt?: string;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 写入输入：智能记忆字段可省略，由存储层补默认值。
 * 保持既有调用方（extractor / REST 路由 / 测试）无需改动即可编译。
 */
export type MemoryCreateInput = Omit<
  Memory,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'importance'
  | 'durability'
  | 'confidence'
  | 'pinned'
  | 'accessCount'
> &
  Partial<Pick<Memory, 'importance' | 'durability' | 'confidence' | 'pinned'>>;

/** 可被清空的记忆可选字段（如清除过期时间、解绑 key） */
export type NullableMemoryField =
  | 'key'
  | 'expiresAt'
  | 'validFrom'
  | 'validTo'
  | 'supersededBy'
  | 'lastAccessedAt';

/**
 * 更新补丁：仅允许这些字段被改写。
 *
 * 可清空字段传 `null` 表示清空（受 tsconfig 的 exactOptionalPropertyTypes 约束，
 * 不能传 `undefined`）。
 */
export type MemoryUpdatePatch = Partial<
  Pick<
    Memory,
    | 'title'
    | 'content'
    | 'category'
    | 'description'
    | 'keywords'
    | 'status'
    | 'importance'
    | 'durability'
    | 'confidence'
    | 'pinned'
  >
> & {
  [K in NullableMemoryField]?: Memory[K] | null;
};

/** 把更新补丁合并进既有记忆（纯函数，供各存储实现复用） */
export function applyMemoryPatch(existing: Memory, patch: MemoryUpdatePatch, now: string): Memory {
  const merged: Memory = { ...existing, updatedAt: now };

  if (patch.title !== undefined) merged.title = patch.title;
  if (patch.content !== undefined) merged.content = patch.content;
  if (patch.category !== undefined) merged.category = patch.category;
  if (patch.description !== undefined) merged.description = patch.description;
  if (patch.keywords !== undefined) merged.keywords = patch.keywords;
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.importance !== undefined) merged.importance = patch.importance;
  if (patch.durability !== undefined) merged.durability = patch.durability;
  if (patch.confidence !== undefined) merged.confidence = patch.confidence;
  if (patch.pinned !== undefined) merged.pinned = patch.pinned;

  if (patch.key === null) delete merged.key;
  else if (patch.key !== undefined) merged.key = patch.key;

  if (patch.expiresAt === null) delete merged.expiresAt;
  else if (patch.expiresAt !== undefined) merged.expiresAt = patch.expiresAt;

  if (patch.validFrom === null) delete merged.validFrom;
  else if (patch.validFrom !== undefined) merged.validFrom = patch.validFrom;

  if (patch.validTo === null) delete merged.validTo;
  else if (patch.validTo !== undefined) merged.validTo = patch.validTo;

  if (patch.supersededBy === null) delete merged.supersededBy;
  else if (patch.supersededBy !== undefined) merged.supersededBy = patch.supersededBy;

  if (patch.lastAccessedAt === null) delete merged.lastAccessedAt;
  else if (patch.lastAccessedAt !== undefined) merged.lastAccessedAt = patch.lastAccessedAt;

  return merged;
}

/** LLM 提取记忆时的结构化输出 schema */
export const MemoryExtractionSchema = z.object({
  memories: z.array(
    z.object({
      title: z.string().min(1).max(100),
      content: z.string().min(1).max(1000),
      category: MemoryCategorySchema,
      description: z.string().min(1).max(200),
      keywords: z.array(z.string().min(1)).min(1).max(10),
      /**
       * 稳定槽位：仅用于唯一身份事实（名字 / 语言偏好 / 项目根路径）。
       * 普通知识不要给 key，否则会被后写覆盖。
       */
      key: z
        .string()
        .regex(/^[a-z0-9_.]+$/)
        .max(64)
        .optional(),
      /** 1-10 重要度；缺失时由 extractor 兜底为中性分 */
      importance: z.number().int().min(1).max(10).optional(),
      /** durable 为默认；ephemeral 需要配合 expiresInDays */
      durability: MemoryDurabilitySchema.optional(),
      confidence: z.number().min(0).max(1).optional(),
      /** 仅 ephemeral 有意义：相对天数（避免模型算错绝对日期） */
      expiresInDays: z.number().int().min(1).max(3650).optional(),
    }),
  ),
});
