// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../FileIcons', () => ({
  FileIcon: () => React.createElement('span', null, '[F]'),
  DirIcon: () => React.createElement('span', null, '[D]'),
}));

vi.mock('../InlineTreeInput', () => ({
  InlineTreeInput: (props: { kind: string; onConfirm: (v: string) => void; onCancel: () => void }) =>
    React.createElement('input', { 'data-testid': `inline-${props.kind}`, 'data-kind': props.kind }),
}));

const { WorkspaceTree } = await import('../WorkspaceTree');

const sampleTree = [
  {
    name: 'docs',
    path: 'docs',
    type: 'directory' as const,
    children: [{ name: 'readme.md', path: 'docs/readme.md', type: 'file' as const }],
  },
  { name: 'index.ts', path: 'index.ts', type: 'file' as const },
];

describe('WorkspaceTree with file management actions', () => {
  it('renders new-file and new-dir icons on directory hover', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(WorkspaceTree, {
          tree: sampleTree,
          loading: false,
          expandedPaths: new Set(['docs']),
          toggleExpand: vi.fn(),
          onSelect: vi.fn(),
          selectedPath: null,
          hasFile: false,
          callbacks: {
            onCreateFile: vi.fn().mockResolvedValue(true),
            onCreateDir: vi.fn().mockResolvedValue(true),
            onDelete: vi.fn().mockResolvedValue(true),
            onRename: vi.fn().mockResolvedValue(true),
          },
        }),
      );
    });

    // Directory row should have new-file and new-dir buttons
    const buttons = container.querySelectorAll('button[title="新建文件"]');
    expect(buttons.length).toBeGreaterThan(0);

    const dirButtons = container.querySelectorAll('button[title="新建目录"]');
    expect(dirButtons.length).toBeGreaterThan(0);

    root.unmount();
  });

  it('renders rename and delete icons on file rows', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(WorkspaceTree, {
          tree: sampleTree,
          loading: false,
          expandedPaths: new Set(['docs']),
          toggleExpand: vi.fn(),
          onSelect: vi.fn(),
          selectedPath: null,
          hasFile: false,
          callbacks: {
            onCreateFile: vi.fn().mockResolvedValue(true),
            onCreateDir: vi.fn().mockResolvedValue(true),
            onDelete: vi.fn().mockResolvedValue(true),
            onRename: vi.fn().mockResolvedValue(true),
          },
        }),
      );
    });

    const renameButtons = container.querySelectorAll('button[title="重命名"]');
    expect(renameButtons.length).toBeGreaterThanOrEqual(2); // dir + files

    const deleteButtons = container.querySelectorAll('button[title="删除"]');
    expect(deleteButtons.length).toBeGreaterThanOrEqual(2);

    root.unmount();
  });

  it('does not render action icons without callbacks', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(WorkspaceTree, {
          tree: sampleTree,
          loading: false,
          expandedPaths: new Set(['docs']),
          toggleExpand: vi.fn(),
          onSelect: vi.fn(),
          selectedPath: null,
          hasFile: false,
        }),
      );
    });

    expect(container.querySelectorAll('button[title="新建文件"]').length).toBe(0);
    expect(container.querySelectorAll('button[title="删除"]').length).toBe(0);

    root.unmount();
  });

  it('shows inline input when new-file button is clicked', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(WorkspaceTree, {
          tree: sampleTree,
          loading: false,
          expandedPaths: new Set(['docs']),
          toggleExpand: vi.fn(),
          onSelect: vi.fn(),
          selectedPath: null,
          hasFile: false,
          callbacks: {
            onCreateFile: vi.fn().mockResolvedValue(true),
            onCreateDir: vi.fn().mockResolvedValue(true),
          },
        }),
      );
    });

    // Click the first new-file button
    const newFileBtn = container.querySelector('button[title="新建文件"]');
    expect(newFileBtn).toBeTruthy();

    act(() => {
      (newFileBtn as HTMLElement)?.click();
    });

    // Inline input should appear
    const inlineInput = container.querySelector('[data-testid="inline-file"]');
    expect(inlineInput).toBeTruthy();

    root.unmount();
  });
});
