import { describe, expect, it } from 'vitest';

import { filterSlashCommands, SLASH_COMMANDS } from '../../src/config/commands.js';

describe('filterSlashCommands', () => {
  it('returns all commands for an empty query', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands('/')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('filters by command prefix', () => {
    const result = filterSlashCommands('/pl');
    expect(result.map((c) => c.command)).toContain('/plan');
    expect(result.map((c) => c.command)).not.toContain('/undo');
  });

  it('is case-sensitive', () => {
    expect(filterSlashCommands('/PL')).toHaveLength(0);
  });

  it('does not match mid-word', () => {
    expect(filterSlashCommands('/che')).toEqual([{ id: 'checkpoints', command: '/checkpoints', description: '列出当前会话检查点' }]);
  });
});
