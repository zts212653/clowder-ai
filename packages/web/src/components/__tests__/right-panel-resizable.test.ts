import { describe, expect, it } from 'vitest';

describe('Right status panel resizable width (#37)', () => {
  it('renders ResizeHandle between chat area and RightStatusPanel', async () => {
    // Read the ChatContainer source to verify the ResizeHandle is adjacent to RightStatusPanel
    const fs = await import('node:fs');
    const path = await import('node:path');
    const chatContainerPath = path.resolve(__dirname, '../ChatContainer.tsx');
    const source = fs.readFileSync(chatContainerPath, 'utf-8');

    // Verify: when status panel is open, ResizeHandle appears before RightStatusPanel
    const statusPanelBlock = source.match(
      /statusPanelOpen && rightPanelMode === 'status'[\s\S]*?<ResizeHandle[\s\S]*?handleStatusPanelResize[\s\S]*?<RightStatusPanel/,
    );
    expect(statusPanelBlock).not.toBeNull();
  });

  it('RightStatusPanel accepts width prop and applies it as inline style', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const panelPath = path.resolve(__dirname, '../RightStatusPanel.tsx');
    const source = fs.readFileSync(panelPath, 'utf-8');

    // Verify the width prop is in the interface and used in the aside element
    expect(source).toContain('width?: number');
    expect(source).toMatch(/style=\{width \? \{ width \} : undefined\}/);
  });

  it('persists status panel width with usePersistedState', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const chatContainerPath = path.resolve(__dirname, '../ChatContainer.tsx');
    const source = fs.readFileSync(chatContainerPath, 'utf-8');

    expect(source).toContain("'cat-cafe:statusPanelWidth'");
    expect(source).toContain('statusPanelWidth');
  });
});
