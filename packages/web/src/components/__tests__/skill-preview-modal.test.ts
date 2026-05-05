import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ content: '# Test Skill\nHello world' }) })),
}));

import { SkillPreviewModal } from '@/components/settings/SkillPreviewModal';

describe('SkillPreviewModal', () => {
  it('renders skill name and description once', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillPreviewModal, {
        skillId: 'test-skill',
        skillName: 'test-skill',
        description: 'A test skill',
        triggers: ['hello', 'world'],
        onClose: () => {},
      }),
    );
    expect(html).toContain('test-skill');
    expect(html).toContain('A test skill');
    expect(html).toContain('hello');
    expect(html).toContain('world');
    expect(html.match(/A test skill/g)).toHaveLength(1);
  });

  it('has X close button and no bottom buttons', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillPreviewModal, {
        skillId: 'x',
        skillName: 'x',
        onClose: () => {},
      }),
    );
    expect(html).toContain('aria-label="关闭"');
    expect(html).not.toContain('>关闭</button>');
    expect(html).not.toContain('编辑配置');
    expect(html).not.toContain('安装依赖');
    expect(html).not.toContain('依赖安装');
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

  it('does not render uninstall button (moved to list card)', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillPreviewModal, {
        skillId: 'ext-skill',
        skillName: 'ext-skill',
        onClose: () => {},
      }),
    );
    expect(html).not.toContain('卸载 Skill');
  });

  it('uses the designed modal structure', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillPreviewModal, {
        skillId: 'browser-automation',
        skillName: 'browser-automation',
        description: '浏览外部网站、处理登录态流程、采集截图与操作证据。',
        triggers: ['外部网站', '截图', '登录', '自动化', '证据', '路由', '额外'],
        category: 'browser',
        onClose: () => {},
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('skill-preview-modal');
    expect(html).toContain('max-w-[620px]');
    expect(html).toContain('rounded-[24px]');
    expect(html).toContain('+1');
    expect(html).not.toContain('触发：额外');
  });
});
