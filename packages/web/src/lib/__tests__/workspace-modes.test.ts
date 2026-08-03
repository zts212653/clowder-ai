import { describe, expect, it } from 'vitest';
import { isWorkspaceMode, WORKSPACE_MODES } from '../workspace-modes';

describe('workspace mode contract', () => {
  it('includes the Eval workspace mode in the shared mode list', () => {
    expect(WORKSPACE_MODES).toContain('eval');
  });

  it('guards unknown preferred workspace modes', () => {
    expect(isWorkspaceMode('eval')).toBe(true);
    expect(isWorkspaceMode('settings')).toBe(false);
    expect(isWorkspaceMode(null)).toBe(false);
  });
});
