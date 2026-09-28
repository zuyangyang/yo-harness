/**
 * 检查点管理器 —— 写操作前快照 + undo 恢复。
 *
 * snapshotBeforeWrite：write_file 执行前调用，读取文件原始内容
 * （不存在则 content=null）并创建检查点。
 * undo：恢复上一个检查点的文件内容；新建文件 → 删除，修改文件 → 恢复原内容。
 *
 * 依赖 CheckpointStore 端口（core/ports.ts），storage 提供实现。
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import type { CheckpointStore } from './ports.js';

export interface UndoResult {
  success: boolean;
  checkpointId?: string;
  files?: string[];
  reason?: string;
}

export class CheckpointManager {
  constructor(
    private readonly store: CheckpointStore,
    private readonly sessionId: string,
  ) {}

  /**
   * write_file 前调用：读取原始内容（文件不存在则 content=null），创建检查点。
   * 返回 checkpointId 供事件记录。
   */
  async snapshotBeforeWrite(
    cwd: string,
    relPath: string,
    seq: number,
  ): Promise<string> {
    const absPath = `${cwd}/${relPath}`;
    let content: Buffer | null = null;
    try {
      content = readFileSync(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // 新建文件，content = null
    }
    return this.store.create({
      sessionId: this.sessionId,
      seq,
      source: 'auto_write',
      files: [{ relPath, content }],
    });
  }

  /**
   * undo：恢复上一个检查点。
   * 返回恢复结果（成功时包含 checkpointId 和恢复的文件列表）。
   */
  async undo(cwd: string, currentSeq: number): Promise<UndoResult> {
    const prev = await this.store.getAdjacent(this.sessionId, currentSeq, 'prev');
    if (prev === undefined) {
      return { success: false, reason: 'no checkpoint to undo' };
    }

    const checkpoint = await this.store.get(prev.id);
    if (checkpoint === undefined) {
      return { success: false, reason: 'checkpoint not found' };
    }

    const restoredFiles: string[] = [];
    for (const file of checkpoint.files) {
      const content = await this.store.readFileContent(prev.id, file.relPath);
      const absPath = `${cwd}/${file.relPath}`;
      if (content === null) {
        // 原来是新建文件 → 删除
        try {
          unlinkSync(absPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // 文件已经不存在，忽略
        }
      } else {
        writeFileSync(absPath, content);
      }
      restoredFiles.push(file.relPath);
    }

    return { success: true, checkpointId: prev.id, files: restoredFiles };
  }
}
