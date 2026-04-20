import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BootstrapProgress, IndexState, ProjectSummary } from '@/hooks/useIndexState';
import { BootstrapAutoNotice } from '../BootstrapAutoNotice';
import { BootstrapProgressPill } from '../BootstrapProgressPill';
import { BootstrapPromptCard } from '../BootstrapPromptCard';
import { BootstrapSummaryCard } from '../BootstrapSummaryCard';

Object.assign(globalThis as Record<string, unknown>, { React });

const missingState: IndexState = {
  status: 'missing',
  fingerprint: '',
  docs_indexed: 0,
  docs_total: 0,
  error_message: null,
  summary_json: null,
  snoozed_until: null,
  last_scan_at: null,
};

const failedState: IndexState = {
  ...missingState,
  status: 'failed',
  error_message: 'disk full',
};

const readyState: IndexState = {
  ...missingState,
  status: 'ready',
  docs_indexed: 42,
};

const staleState: IndexState = {
  ...missingState,
  status: 'stale',
};

const mockSummary: ProjectSummary = {
  projectName: 'test-project',
  techStack: ['node', 'typescript'],
  dirStructure: ['src', 'docs', 'packages'],
  coreModules: ['api', 'web', 'shared'],
  docsList: [
    { path: 'docs/README.md', tier: 'authoritative' },
    { path: 'docs/ARCH.md', tier: 'derived' },
  ],
  tierCoverage: { authoritative: 1, derived: 1, soft_clue: 2 },
  kindCoverage: { feature: 10, decision: 3, lesson: 5, phase: 8 },
};

const scanningProgress: BootstrapProgress = {
  phase: 'scanning',
  phaseIndex: 0,
  totalPhases: 4,
  docsProcessed: 0,
  docsTotal: 0,
  elapsedMs: 500,
};

const extractingProgress: BootstrapProgress = {
  phase: 'extracting',
  phaseIndex: 1,
  totalPhases: 4,
  docsProcessed: 5,
  docsTotal: 20,
  elapsedMs: 1500,
};

describe('BootstrapPromptCard', () => {
  it('renders prompt when index state is missing', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={missingState}
        isSnoozed={false}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toContain('这个项目还没有记忆索引');
    expect(html).toContain('开始扫描');
    expect(html).toContain('稍后再说');
    expect(html).toContain('bootstrap-prompt-card');
  });

  it('renders retry message when failed', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={failedState}
        isSnoozed={false}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toContain('记忆索引构建失败');
    expect(html).toContain('disk full');
    expect(html).toContain('重试扫描');
  });

  it('renders update message when stale', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={staleState}
        isSnoozed={false}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toContain('记忆索引已过期');
    expect(html).toContain('更新索引');
  });

  it('renders nothing when snoozed', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={missingState}
        isSnoozed={true}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('renders nothing when ready', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={readyState}
        isSnoozed={false}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('renders nothing when building', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={{ ...missingState, status: 'building' }}
        isSnoozed={false}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('shows project directory name in failed/stale states', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={failedState}
        isSnoozed={false}
        projectPath="/home/user/my-project"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toContain('my-project');
  });

  it('shows three info bullets in default state', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={missingState}
        isSnoozed={false}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toContain('扫描范围');
    expect(html).toContain('预计耗时');
    expect(html).toContain('数据安全');
  });

  it('uses cocreator color classes', () => {
    const html = renderToStaticMarkup(
      <BootstrapPromptCard
        indexState={missingState}
        isSnoozed={false}
        projectPath="/tmp/foo"
        onStartScan={() => {}}
        onSnooze={() => {}}
      />,
    );
    expect(html).toContain('cocreator-primary');
    expect(html).toContain('cocreator-bg');
  });
});

describe('BootstrapProgressPill', () => {
  it('renders collapsed pill with phase label', () => {
    const html = renderToStaticMarkup(<BootstrapProgressPill progress={scanningProgress} />);
    expect(html).toContain('建立记忆索引…');
    expect(html).toContain('bootstrap-progress-pill');
    expect(html).toContain('扫描文件 (1/4)');
  });

  it('renders expanded view with phase list', () => {
    const html = renderToStaticMarkup(<BootstrapProgressPill progress={extractingProgress} expanded />);
    expect(html).toContain('扫描文件');
    expect(html).toContain('提取结构');
    expect(html).toContain('构建索引');
    expect(html).toContain('生成摘要');
  });

  it('shows done checkmark for completed phases', () => {
    const html = renderToStaticMarkup(<BootstrapProgressPill progress={extractingProgress} expanded />);
    expect(html).toContain('✓');
  });

  it('shows doc progress when available', () => {
    const html = renderToStaticMarkup(<BootstrapProgressPill progress={extractingProgress} expanded />);
    expect(html).toContain('5 / 20 文档');
  });

  it('uses cocreator colors', () => {
    const html = renderToStaticMarkup(<BootstrapProgressPill progress={scanningProgress} />);
    expect(html).toContain('cocreator-primary');
  });
});

describe('BootstrapSummaryCard', () => {
  it('renders summary with project name and doc count', () => {
    const html = renderToStaticMarkup(<BootstrapSummaryCard summary={mockSummary} docsIndexed={42} />);
    expect(html).toContain('记忆索引构建完成');
    expect(html).toContain('test-project');
    expect(html).toContain('42 个文档');
    expect(html).toContain('bootstrap-summary-card');
  });

  it('shows kind coverage with F102 source type labels', () => {
    const html = renderToStaticMarkup(<BootstrapSummaryCard summary={mockSummary} docsIndexed={10} />);
    expect(html).toContain('功能');
    expect(html).toContain('决策');
    expect(html).toContain('教训');
    expect(html).toContain('阶段');
    expect(html).toContain('知识覆盖');
    // Must not leak provenance tier labels into display
    expect(html).not.toContain('authoritative');
    expect(html).not.toContain('derived');
    expect(html).not.toContain('soft_clue');
  });

  it('falls back to tierCoverage when kindCoverage is empty (external projects)', () => {
    const externalSummary: ProjectSummary = {
      ...mockSummary,
      kindCoverage: {},
      tierCoverage: { authoritative: 5, derived: 3, soft_clue: 1 },
    };
    const html = renderToStaticMarkup(<BootstrapSummaryCard summary={externalSummary} docsIndexed={9} />);
    // Must show tier fallback section, not be empty
    expect(html).toContain('覆盖分层');
    expect(html).toContain('核心');
    expect(html).toContain('衍生');
    expect(html).toContain('线索');
  });

  it('shows duration when provided', () => {
    const html = renderToStaticMarkup(
      <BootstrapSummaryCard summary={mockSummary} docsIndexed={10} durationMs={23000} />,
    );
    expect(html).toContain('23 秒');
  });

  it('renders action buttons with placeholder CTAs disabled', () => {
    const html = renderToStaticMarkup(
      <BootstrapSummaryCard summary={mockSummary} docsIndexed={10} onDismiss={() => {}} />,
    );
    expect(html).toContain('关闭');
    expect(html).toContain('搜索知识');
    expect(html).toContain('前往记忆中心');
    // P2-1: CTAs without handlers must be disabled
    expect(html).toContain('disabled');
  });

  it('uses green color theme', () => {
    const html = renderToStaticMarkup(<BootstrapSummaryCard summary={mockSummary} docsIndexed={10} />);
    expect(html).toContain('green-200');
    expect(html).toContain('green-50');
  });

  it('renders SVG icons instead of emoji', () => {
    const html = renderToStaticMarkup(
      <BootstrapSummaryCard summary={mockSummary} docsIndexed={42} durationMs={5000} />,
    );
    expect(html).toContain('<svg');
    expect(html).not.toContain('✅');
    expect(html).not.toContain('📁');
    expect(html).not.toContain('📄');
    expect(html).not.toContain('⏱');
  });

  it('enables buttons when handlers are provided', () => {
    const html = renderToStaticMarkup(
      <BootstrapSummaryCard
        summary={mockSummary}
        docsIndexed={10}
        onDismiss={() => {}}
        onSearchKnowledge={() => {}}
        onGoToMemoryHub={() => {}}
      />,
    );
    expect(html).toContain('搜索知识');
    expect(html).toContain('前往记忆中心');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('cursor-not-allowed');
  });

  it('uses SVG icons in button labels instead of emoji', () => {
    const html = renderToStaticMarkup(
      <BootstrapSummaryCard
        summary={mockSummary}
        docsIndexed={10}
        onSearchKnowledge={() => {}}
        onGoToMemoryHub={() => {}}
      />,
    );
    expect(html).not.toContain('🔍');
    expect(html).not.toContain('🧠');
    // Buttons should contain SVG icons
    const svgCount = (html.match(/<svg/g) ?? []).length;
    expect(svgCount).toBeGreaterThanOrEqual(2);
  });
});

describe('BootstrapAutoNotice', () => {
  it('renders amber auto-chain notice', () => {
    const html = renderToStaticMarkup(<BootstrapAutoNotice />);
    expect(html).toContain('bootstrap-auto-notice');
    expect(html).toContain('正在自动建立记忆索引');
    expect(html).toContain('治理初始化完成');
    expect(html).toContain('amber');
  });
});
