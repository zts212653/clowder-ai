import { describe, expect, it, vi } from 'vitest';

const brand = vi.hoisted(() => ({
  name: 'Remaining ASCII',
  displayName: 'Remaining Display',
  shortName: 'R',
  hubName: 'Remaining Hub',
  tagline: 'Remaining team',
}));
vi.mock('@cat-cafe/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cat-cafe/shared')>();
  return { ...actual, deploymentDefaults: { ...actual.deploymentDefaults, brand } };
});

import type { HubCatEditorFormState } from '@/components/hub-cat-editor.model';
import { memberEditorChanges } from '@/components/members/member-editor-changes';
import { editorCopy } from '@/components/members/members.editor-copy';
import { membersCopy } from '@/components/members/members.shell-copy';
import { sessionChainCopy } from '@/components/session-chain.shell-copy';
import { codeToolsCopy } from '@/components/workspace/code-tools.shell-copy';
import { parsePreviewUrl } from '@/components/workspace/preview-url-utils';
import { trajectoryInputCopy } from '@/components/workspace/trajectory/trajectory-input.shell-copy';

function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(textValues) : [];
}

describe('remaining deployment copy consumers', () => {
  it('resolves stable member-change keys to the selected brand in both languages', () => {
    const baseline = { mcpSupport: true } as HubCatEditorFormState;
    for (const english of [false, true]) {
      const changes = memberEditorChanges(
        { ...baseline, mcpSupport: false },
        baseline,
        null,
        null,
        null,
        null,
        english,
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].label).toBe(`${brand.displayName} ${english ? 'tools' : '工具'}`);
    }
  });
  for (const [label, copy] of Object.entries({
    sessionChainCopy,
    membersCopy,
    editorCopy,
    codeToolsCopy,
    trajectoryInputCopy,
  })) {
    it(`${label} emits synthetic labels while retaining stable translation keys`, () => {
      const values = textValues(copy);
      expect(values.some((value) => value.includes(brand.displayName))).toBe(true);
      expect(values.filter((value) => /Cat Caf[eé]/.test(value))).toEqual([]);
    });
  }
  it('uses the selected brand in generated tool summaries and actual preview warnings', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(trajectoryInputCopy[locale].toolsSummary('a', 'b', 'c', 'd')).toContain(brand.displayName);
    }
    expect(parsePreviewUrl('localhost:4510/thread/example').warning).toContain(brand.displayName);
  });
});
