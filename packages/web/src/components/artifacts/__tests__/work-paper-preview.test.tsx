import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WorkPaperPreview } from '../WorkPaperPreview';

const source = vi.hoisted(() => ({ content: '' }));
vi.mock('@/hooks/useArtifactContent', () => ({ useArtifactContent: () => source }));

// Original Human850 file header: the title must come from the readable body,
// while copied/downloaded source remains the original Markdown (including YAML).
const originalHeader = `---
feature_ids: [F202, F290, F309, F310, F311, F314, F317, F329, F332]
topics: [clowder-ai, plugin-architecture, roadmap-discussion, rsi, collaboration]
doc_kind: discussion
created: 2026-10-26
updated: 2026-10-27
status: draft-for-discussion
source_thread: thread_owned_177172a9f6f83c7b7299ee56273655613ccb4e74
source_messages: [0001793065719597-000175-73f6616e, 0001793069910424-000424-21a960ef, 0001793081683850-000849-3bfa319a]
---

# Clowder AI 后续建设：一条主线与十个并行方向

> 讨论稿 v0.2 · 2026-10-27`;

async function paper(content: string, name = 'guide.md', type: 'file' | 'code' = 'file') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  source.content = content;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WorkPaperPreview
          kind={type === 'code' ? 'code' : 'document'}
          artifact={{ type, name, url: `/uploads/${name}`, catId: 'codex61-sol', createdAt: 1, sourceMessageId: null }}
        />,
      ),
    );
    return {
      heading: host.querySelector('strong')?.textContent,
      excerpt: host.querySelector('.work-cover-excerpt')?.textContent,
      bars: host.querySelectorAll('.work-cover-bar').length,
    };
  } finally {
    await act(async () => root.unmount());
  }
}

it('previews the original discussion heading instead of YAML metadata without rewriting source', async () => {
  const result = await paper(originalHeader, 'Clowder_AI_后续建设与分工讨论稿-v0_2.md');
  expect(result.heading).toBe('Clowder AI 后续建设：一条主线与十个并行方向');
  expect(result.excerpt).toBe('\n> 讨论稿 v0.2 · 2026-10-27');
  expect(source.content).toBe(originalHeader);
});

it.each([
  'guide.md',
  'guide.markdown',
  'guide.mdx',
])('uses the Markdown body for %s with BOM and CRLF', async (name) => {
  const result = await paper('\uFEFF---\r\ntitle: 元数据\r\n---\r\n\r\n# 正文标题\r\n正文摘要', name);
  expect(result.heading).toBe('正文标题\r');
  expect(result.excerpt).toBe('正文摘要');
});

it.each([
  ['missing closing fence', '---\ntitle: 未闭合\n# 必须保留'],
  ['not a closing fence', '---\ntitle: 保留\n---不是分隔符\n# 正文'],
  ['body separator', '前言\n---\ntitle: 正文数据\n---\n# 后续标题'],
])('preserves Markdown with %s', async (_label, content) => {
  const result = await paper(content);
  expect(result.heading).toBe(content.split('\n')[0]);
  expect(result.excerpt).toContain('title:');
});

it.each([
  ['notes.txt', 'file'],
  ['config.yaml', 'file'],
  ['source.py', 'code'],
] as const)('does not interpret frontmatter-like lines in %s', async (name, type) => {
  const result = await paper('---\ntitle: 这是原文\n---\n正文', name, type);
  expect(result.heading).toBe('---');
  expect(result.excerpt).toBe('title: 这是原文\n---\n正文');
});

it('uses the existing empty preview when a Markdown file contains only metadata', async () => {
  const result = await paper('---\ntitle: 只有元数据\n---\n');
  expect(result.heading).toBeUndefined();
  expect(result.excerpt).toBeUndefined();
  expect(result.bars).toBeGreaterThan(0);
});

it.each([
  ['notes.txt', 'file', ''],
  ['notes.txt', 'file', ' \n\t'],
  ['source.py', 'code', ''],
  ['source.py', 'code', ' \n\t'],
] as const)('uses placeholder bars for empty/whitespace %s covers', async (name, type, content) => {
  const result = await paper(content, name, type);
  expect(result.heading).toBeUndefined();
  expect(result.excerpt).toBeUndefined();
  expect(result.bars).toBeGreaterThan(0);
});

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
