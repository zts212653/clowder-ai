/**
 * F203 Phase F — L0 system prompt visibility (read-only viewer).
 *
 * Tests the pure props-driven sub-components extracted from
 * RulesPromptsContent. Async fetch + modal interactions covered by
 * Playwright e2e in Task 4 (per plan).
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type L0PromptsBlock,
  L0PromptsSection,
  RuleFileCard,
  shouldShowL0Section,
} from '@/components/settings/RulesPromptsContent';
import { ConsumptionLegend } from '@/components/settings/RulesPromptsParts';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

const SAMPLE_L0: L0PromptsBlock = {
  template: {
    path: 'assets/system-prompts/system-prompt-l0.md',
    content: '# L0 template body',
    exists: true,
    consumption: {
      kind: 'actual-prompt',
      label: '实际进 prompt',
      detail: 'Template is compiled per cat and injected into the native system role.',
      consumers: ['compile-system-prompt-l0.mjs'],
    },
  },
  compiledByCat: [
    {
      catId: 'opus-47',
      displayName: '布偶猫 Opus 4.7',
      compiled: 'compiled-for-opus-47',
      error: null,
      consumption: {
        kind: 'actual-prompt',
        label: '实际进 prompt',
        detail: 'Per-cat compiled L0 actually passed to the model.',
        consumers: ['ClaudeBgCarrierService'],
      },
    },
    {
      catId: 'codex',
      displayName: '缅因猫 GPT-5.5(codex)',
      compiled: 'compiled-for-codex',
      error: null,
      consumption: {
        kind: 'actual-prompt',
        label: '实际进 prompt',
        detail: 'Per-cat compiled L0 actually passed to the model.',
        consumers: ['CodexAgentService'],
      },
    },
    {
      catId: 'broken',
      displayName: 'Broken Cat',
      compiled: '',
      error: 'simulated compile failure',
      consumption: {
        kind: 'actual-prompt',
        label: '实际进 prompt',
        detail: 'Per-cat compiled L0 actually passed to the model.',
        consumers: ['compile-system-prompt-l0.mjs'],
      },
    },
  ],
  customization: {
    templatePath: 'assets/system-prompts/system-prompt-l0.md',
    compileScript: 'scripts/compile-system-prompt-l0.mjs',
    verifyCommand: 'pnpm gate + runtime restart (KD-5 git revert 回滚通道)',
  },
};

describe('L0PromptsSection (F203 Phase F)', () => {
  it('renders title, template card, and template path (AC-F2/F3)', () => {
    const html = renderToStaticMarkup(<L0PromptsSection l0Prompts={SAMPLE_L0} onPreview={() => {}} />);
    expect(html).toContain('L0 系统提示词');
    expect(html).toContain('assets/system-prompts/system-prompt-l0.md');
    expect(html).toContain('查看');
  });

  it('renders template path and line count in the template row', () => {
    const html = renderToStaticMarkup(<L0PromptsSection l0Prompts={SAMPLE_L0} onPreview={() => {}} />);
    expect(html).toContain('assets/system-prompts/system-prompt-l0.md');
    expect(html).toContain('行');
  });
});

describe('Prompt consumption chain UX (#749)', () => {
  it('renders the four consumption classes in the legend', () => {
    const html = renderToStaticMarkup(<ConsumptionLegend />);
    expect(html).toContain('实际进 prompt');
    expect(html).toContain('harness 注入');
    expect(html).toContain('只是参考');
    expect(html).toContain('skill 按需加载');
  });

  it('RuleFileCard renders label and path for clickable cards', () => {
    const html = renderToStaticMarkup(
      <RuleFileCard
        file={{
          path: 'cat-cafe-skills/refs/shared-rules.md',
          content: '# shared rules',
          exists: true,
          consumption: {
            kind: 'actual-prompt',
            label: '实际进 prompt',
            detail: 'shared-rules.md → governance L0 → native/fallback prompt paths.',
            consumers: ['compile-system-prompt-l0.mjs', 'SystemPromptBuilder'],
          },
        }}
        onClick={() => {}}
      />,
    );
    expect(html).toContain('shared-rules.md');
    expect(html).toContain('查看');
  });
});

describe('RuleFileCard error UX (F203 Phase F 砚砚 plan-review refinement)', () => {
  it('with errorMessage shows "编译失败" not "文件不存在"', () => {
    const html = renderToStaticMarkup(
      <RuleFileCard
        file={{
          path: 'compiled://broken',
          content: '',
          exists: false,
          consumption: {
            kind: 'actual-prompt',
            label: '实际进 prompt',
            detail: 'Per-cat compiled L0 actually passed to the model.',
            consumers: ['compile-system-prompt-l0.mjs'],
          },
        }}
        label="Broken"
        onClick={() => {}}
        errorMessage="simulated compile failure"
      />,
    );
    expect(html).toContain('编译失败');
    expect(html).not.toContain('文件不存在');
  });

  it('with errorMessage = "" still shows "编译失败" (cloud R3: empty string IS a failure, not no-error)', () => {
    // Cloud R3 P2: `new Error('').message === ''`; readL0Prompts forwards
    // e.message directly. A truthy check (`if (errorMessage)`) treats `""` as
    // "no error" and misclassifies as "文件不存在". Use explicit presence
    // check (errorMessage !== undefined) so the prop semantic is "set means
    // failure, regardless of text content".
    const html = renderToStaticMarkup(
      <RuleFileCard
        file={{
          path: 'compiled://broken',
          content: '',
          exists: false,
          consumption: {
            kind: 'actual-prompt',
            label: '实际进 prompt',
            detail: 'Per-cat compiled L0 actually passed to the model.',
            consumers: ['compile-system-prompt-l0.mjs'],
          },
        }}
        label="Empty Err"
        onClick={() => {}}
        errorMessage=""
      />,
    );
    expect(html).toContain('编译失败');
    expect(html).not.toContain('文件不存在');
  });

  it('without errorMessage and !exists still shows "文件不存在" (existing behavior unchanged)', () => {
    const html = renderToStaticMarkup(
      <RuleFileCard
        file={{
          path: 'missing/file.md',
          content: '',
          exists: false,
          consumption: {
            kind: 'reference',
            label: '只是参考',
            detail: 'Reference workflow document; not injected into every prompt.',
            consumers: [],
          },
        }}
        label="Missing"
        onClick={() => {}}
      />,
    );
    expect(html).toContain('文件不存在');
    expect(html).not.toContain('编译失败');
  });
});

describe('L0 gate — shouldShowL0Section predicate (#723 P1-7)', () => {
  it('returns false when template.exists is false (open-source builds)', () => {
    const l0 = { ...SAMPLE_L0, template: { ...SAMPLE_L0.template, exists: false } };
    expect(shouldShowL0Section(l0)).toBe(false);
  });

  it('returns true when template.exists is true', () => {
    expect(shouldShowL0Section(SAMPLE_L0)).toBe(true);
  });

  it('returns false when l0Prompts is undefined', () => {
    expect(shouldShowL0Section(undefined)).toBe(false);
  });
});
