/**
 * 角色路由器：根据 ModelRole 返回对应的 LLMClient。
 *
 * 不替代 LLMGateway（网关仍负责重试 / 用量统计）。
 * Router 只解决"用哪个模型"的问题，Gateway 解决"怎么可靠地调用"的问题。
 */
import type { LLMClient } from '../types/llm.js';
import type { ModelRole, ModelRoleMap } from '../types/router.js';
import type { LLMGateway } from '../llm/gateway.js';

export class ModelRouter {
  private readonly roleMap: Map<ModelRole, LLMClient>;
  private readonly roleProviderMap: Map<ModelRole, string>;

  constructor(
    private readonly gateway: LLMGateway,
    roleConfig: ModelRoleMap,
  ) {
    this.roleMap = new Map();
    this.roleProviderMap = new Map();
    for (const [role, cfg] of Object.entries(roleConfig)) {
      if (!cfg) continue;
      const client = gateway.getClient(cfg.provider);
      if (!client) {
        throw new Error(
          `ModelRouter: provider '${cfg.provider}' not found for role '${role}'`,
        );
      }
      this.roleMap.set(role as ModelRole, client);
      this.roleProviderMap.set(role as ModelRole, cfg.provider);
    }
  }

  /** 获取角色对应的 LLMClient。未配置则回退到 gateway 默认 client */
  getClient(role: ModelRole): LLMClient {
    return this.roleMap.get(role) ?? this.gateway.getDefaultClient();
  }

  /** 获取角色对应的 provider 名（供 CostTracker 记录） */
  getProvider(role: ModelRole): string {
    return this.roleProviderMap.get(role) ?? this.gateway.provider;
  }

  /** 列出全部角色分配（供 /models 命令展示） */
  listRoles(): Array<{ role: ModelRole; provider: string; model: string }> {
    const result: Array<{ role: ModelRole; provider: string; model: string }> = [];
    for (const [role, client] of this.roleMap.entries()) {
      result.push({ role, provider: this.roleProviderMap.get(role) ?? '', model: client.name });
    }
    return result;
  }
}
