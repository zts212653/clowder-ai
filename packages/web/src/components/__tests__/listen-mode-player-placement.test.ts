import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readComponent(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src/components', name), 'utf8');
}

describe('Listen Mode player placement', () => {
  it('uses the WorkspacePanel for full controls and AppShell for the compact away control', () => {
    const appShell = readComponent('AppShell.tsx');
    const workspacePanel = readComponent('WorkspacePanel.tsx');

    expect(appShell).toContain('<ListenModePlayer variant="mini"');
    expect(workspacePanel).toContain('<ListenModePlayer />');
  });
});
