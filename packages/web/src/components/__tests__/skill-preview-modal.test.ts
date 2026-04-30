import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ content: '# Test Skill\nHello world' }) })),
}));

import { SkillPreviewModal } from '@/components/settings/SkillPreviewModal';

describe('SkillPreviewModal', () => {
  it('renders modal with skill name and triggers', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillPreviewModal, {
        skillId: 'test-skill',
        skillName: 'test-skill',
        description: 'A test skill',
        triggers: ['hello', 'world'],
        category: 'testing',
        onClose: () => {},
      }),
    );
    expect(html).toContain('test-skill');
    expect(html).toContain('A test skill');
    expect(html).toContain('hello');
    expect(html).toContain('world');
    expect(html).toContain('testing');
    expect(html).toContain('只读预览');
    expect(html).toContain('cat-cafe-skills/test-skill');
  });

  it('shows loading state initially', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillPreviewModal, {
        skillId: 'x',
        skillName: 'x',
        onClose: () => {},
      }),
    );
    expect(html).toContain('加载中');
  });

  it('renders close button and degradation note', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillPreviewModal, {
        skillId: 'x',
        skillName: 'x',
        onClose: () => {},
      }),
    );
    expect(html).toContain('关闭');
    expect(html).toContain('配置编辑功能开发中');
  });
});
