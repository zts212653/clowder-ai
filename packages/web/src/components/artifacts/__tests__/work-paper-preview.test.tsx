import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WorkPaperPreview } from '../WorkPaperPreview';

const source = vi.hoisted(() => ({ content: '' }));
vi.mock('@/hooks/useArtifactContent', () => ({ useArtifactContent: () => source }));

it('shows readable headings throughout the paper cover while preserving body text', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  source.content =
    '# 共同作品接力指南（第1版）\n## 目的\n让参与者围绕共同目标接力创作。\n### 协作步骤\n选择共同目标，保留 C# 示例与正文里的 # 标签。';
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WorkPaperPreview
          kind="document"
          artifact={{
            type: 'file',
            name: '共同作品接力指南-第1版.md',
            url: '/uploads/guide.md',
            catId: 'opus55',
            createdAt: 1,
            sourceMessageId: null,
          }}
        />,
      ),
    );
    expect(host.querySelector('strong')?.textContent).toBe('共同作品接力指南（第1版）');
    expect(host.querySelector('.work-cover-excerpt')?.textContent).toBe(
      '目的\n让参与者围绕共同目标接力创作。\n协作步骤\n选择共同目标，保留 C# 示例与正文里的 # 标签。',
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it('preserves the shebang and comment markers in a code cover', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  source.content = '#!/usr/bin/env python3\n# note\nimport os';
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WorkPaperPreview
          kind="code"
          artifact={{
            type: 'code',
            name: 'a.py',
            url: '/uploads/a.py',
            catId: 'codex61-sol',
            createdAt: 1,
            sourceMessageId: null,
          }}
        />,
      ),
    );
    expect(host.querySelector('.work-cover-excerpt')?.textContent).toBe('# note\nimport os');
    expect(host.querySelector('strong')?.textContent).toBe('#!/usr/bin/env python3');
  } finally {
    await act(async () => root.unmount());
  }
});
