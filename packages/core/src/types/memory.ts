/**
 * 语义记忆数据模型。
 *
 * 记忆 = 跨会话持久化的结构化知识（用户偏好 / 环境事实 / 项目约定）。
 * 由 MemoryExtractor 从对话中自动提取，或用户手动添加。
 * 存取边界用 zod schema 校验。
 */
import { z } from 'zod';

export const MemoryCategorySchema = z.enum([
  'preference',
  'environment',
  'project_knowledge',
  'general',
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

export const MemoryStatusSchema = z.enum(['active', 'archived']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

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
  createdAt: string;
  updatedAt: string;
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
    }),
  ),
});
