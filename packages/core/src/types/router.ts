/**
 * 多模型路由类型。
 *
 * ModelRole 决定"哪个模型干什么"——主循环用强模型、压缩/提取用便宜模型。
 * ModelRoleMap 是配置层的 role → provider+model 映射。
 * RoleUsage 记录单次调用的角色 + 用量，供 CostTracker 汇总。
 */

export type ModelRole = 'main' | 'planner' | 'compressor' | 'extractor';

export interface RoleModelConfig {
  provider: string;
  model: string;
}

/** 角色 → 模型映射（Partial：未配置的角色回退默认 provider） */
export type ModelRoleMap = Partial<Record<ModelRole, RoleModelConfig>>;

/** 单次角色调用的用量记录 */
export interface RoleUsage {
  role: ModelRole;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 本次调用成本（USD）；由 CostTracker 按价格表填充，无价格时缺省 */
  cost?: number;
}
