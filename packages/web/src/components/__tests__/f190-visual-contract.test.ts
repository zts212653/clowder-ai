// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
function readSrc(relativePath: string): string {
  return readFileSync(resolve(testDir, '..', relativePath), 'utf8');
}

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = resolve(root, entry);
    if (full.includes('/__tests__/')) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe('F190 visual contract — no hard borders in card/panel components', () => {
  it('SessionChainPanel uses settingsResourceCardClass, not border-[var(--console-border-soft)]', () => {
    const src = readSrc('SessionChainPanel.tsx');
    expect(src).toContain('settingsResourceCardClass');
    expect(src).not.toMatch(/className="rounded-lg border border-\[var\(--console-border-soft\)\]/);
  });

  it('AuditExplorerPanel uses settingsResourceCardClass, not border-[var(--console-border-soft)]', () => {
    const src = readSrc('audit/AuditExplorerPanel.tsx');
    expect(src).toContain('settingsResourceCardClass');
    expect(src).not.toMatch(/className="rounded-lg border border-\[var\(--console-border-soft\)\]/);
  });

  it('ChatMessage bubble has no literal border class or borderColor style', () => {
    const src = readSrc('ChatMessage.tsx');
    expect(src).not.toMatch(/className=\{`border px-4/);
    expect(src).not.toContain('borderColor: catStyle.borderColor');
  });

  it('SectionCard uses rounded-[18px] shadow, not rounded-2xl border', () => {
    const src = readSrc('hub-cat-editor-fields.tsx');
    expect(src).toMatch(/rounded-\[18px\].*p-\[18px\]/);
    expect(src).not.toMatch(/className=\{`rounded-2xl border p-\[18px\]/);
  });

  it('editor inputs use rounded-[10px] border-transparent, not rounded-xl border-[var(--console-border-soft)]', () => {
    const src = readSrc('hub-cat-editor-fields.tsx');
    expect(src).toContain('rounded-[10px]');
    expect(src).toContain('border-transparent');
    expect(src).not.toMatch(
      /rounded-xl border.*border-\[var\(--console-border-soft\)\].*bg-\[var\(--console-card-bg\)\]/,
    );
  });

  it('editor fields use console-runtime-* tokens, not field-success-*', () => {
    const src = readSrc('hub-cat-editor-fields.tsx');
    expect(src).not.toContain('field-success');
    expect(src).not.toContain('field-persist');
    expect(src).toContain('console-runtime-label');
    expect(src).toContain('console-runtime-field-bg');
    expect(src).toContain('console-persistence-bg');
  });

  it('PersistenceBanner uses console-persistence-bg, not field-persist-*', () => {
    const src = readSrc('hub-cat-editor-fields.tsx');
    expect(src).toMatch(/PersistenceBanner[\s\S]*?console-persistence-bg/);
    expect(src).toMatch(/PersistenceBanner[\s\S]*?shadow-\[0_6px_18px/);
  });

  it('VoiceConfigSection uses shadow, not dashed border', () => {
    const src = readSrc('hub-cat-editor-voice.tsx');
    expect(src).not.toMatch(/border-dashed/);
    expect(src).toMatch(/rounded-\[18px\].*shadow-\[0_8px_22px/);
  });

  it('SessionChainPanel active/sealed cards use console-list-card shadow, not border+borderColor style', () => {
    const src = readSrc('SessionChainPanel.tsx');
    expect(src).toMatch(/data-testid="session-card-active"[\s\S]*?console-list-card/);
    expect(src).toMatch(/data-testid="session-card-sealed"[\s\S]*?console-list-card/);
    expect(src).not.toMatch(/border-\[1\.5px\]/);
    expect(src).not.toContain('borderColor:');
  });

  it('SettingsShell nav uses --console-panel-bg, not border-r', () => {
    const src = readSrc('settings/SettingsShell.tsx');
    expect(src).toContain('bg-[var(--console-panel-bg)]');
    expect(src).not.toMatch(/md:border-r/);
  });

  it('DefaultCatSelector uses console-card-bg shadow, not border-cafe', () => {
    const src = readSrc('DefaultCatSelector.tsx');
    expect(src).toContain('bg-[var(--console-card-bg)]');
    expect(src).toContain('shadow-[var(--shadow-elevation-2)]');
    expect(src).not.toMatch(/border border-cafe bg-cafe-surface/);
  });

  it('BrakeSettingsPanel uses console-list-card shadow, not border-cafe', () => {
    const src = readSrc('BrakeSettingsPanel.tsx');
    expect(src).toContain('console-list-card');
    expect(src).toContain('shadow-[var(--shadow-elevation-2)]');
    expect(src).not.toMatch(/border border-cafe bg-cafe-surface-elevated/);
    expect(src).not.toMatch(/border border-indigo-100/);
  });

  it('HubToolUsageTab uses console/cafe tokens, no hub-* CSS vars, refresh is secondary button', () => {
    const src = readSrc('HubToolUsageTab.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    expect(src).toContain('console-list-card');
    expect(src).toContain('console-form-input');
    expect(src).not.toContain('console-button-emphasis');
    expect(src).toContain('console-card-bg');
    expect(src).toContain('hover:bg-[var(--console-hover-bg)]');
  });

  it('HubConnectorConfigTab uses SettingsRow-aligned shadow, not --hub-shadow var', () => {
    const src = readSrc('HubConnectorConfigTab.tsx');
    expect(src).not.toContain('var(--hub-shadow)');
    expect(src).toContain('console-list-card rounded-xl overflow-hidden shadow-[var(--console-shadow-soft)]');
    expect(src).not.toContain('shadow-[0_12px_30px');
  });

  it('SignalInboxView title is text-xl, list pane has no border-r', () => {
    const src = readSrc('signals/SignalInboxView.tsx');
    expect(src).toMatch(/text-xl font-bold/);
    expect(src).not.toMatch(/border-r border-\[var\(--console-border-soft\)\]/);
  });

  it('SignalSourcesView title is "信号源" text-xl', () => {
    const src = readSrc('signals/SignalSourcesView.tsx');
    expect(src).toContain('text-xl font-bold');
    expect(src).toMatch(/>信号源</);
  });

  it('ResizeHandle uses full-height line with hover feedback', () => {
    const src = readSrc('workspace/ResizeHandle.tsx');
    expect(src).toContain('inset-y-0');
    expect(src).toContain('cafe-accent/60');
    expect(src).toContain('group-hover');
    expect(src).toContain('cursor-col-resize');
    expect(src).toContain('cursor-row-resize');
    expect(src).toContain('console-border-soft');
  });

  it('HubQuotaBoardTab uses console-list-card shadow, no hub-* CSS vars', () => {
    const src = readSrc('HubQuotaBoardTab.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    expect(src).not.toContain('field-success');
    expect(src).toContain('console-list-card');
    expect(src).toContain('text-cafe');
    expect(src).toContain('cafe-accent');
    expect(src).toContain('conn-red-ring');
  });

  it('hub-cat-editor-advanced uses console-runtime-* tokens, no hub-* CSS vars', () => {
    const src = readSrc('hub-cat-editor-advanced.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    expect(src).toContain('console-runtime-hint');
    expect(src).toContain('console-runtime-group-bg');
    expect(src).toContain('console-runtime-field-bg');
    expect(src).toContain('console-field-bg');
    expect(src).toMatch(/rounded-\[14px\].*console-runtime-group-bg/);
  });

  it('HubRoutingPolicyTab uses console-list-card shadow, not border-cafe', () => {
    const src = readSrc('HubRoutingPolicyTab.tsx');
    expect(src).not.toMatch(/border border-cafe/);
    expect(src).toContain('console-list-card');
  });

  it('DailyUsageSection uses console-list-card shadow, not border-cafe', () => {
    const src = readSrc('DailyUsageSection.tsx');
    expect(src).not.toMatch(/border border-cafe/);
    expect(src).toContain('console-list-card');
  });

  it('leaderboard-cards uses cafe/console tokens, no hub-lb-* CSS vars', () => {
    const src = readSrc('leaderboard-cards.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    /* F056: cafe-text-primary → cafe-text (OKLCH token rename) */
    expect(src).toMatch(/cafe-text(?!-)/);
    expect(src).toContain('cafe-accent');
    expect(src).toContain('console-pill-bg');
  });

  it('leaderboard-phase-bc uses cafe/console tokens, no hub-lb-* CSS vars', () => {
    const src = readSrc('leaderboard-phase-bc.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    /* F056: cafe-text-primary → cafe-text (OKLCH token rename) */
    expect(src).toMatch(/cafe-text(?!-)/);
    expect(src).toContain('cafe-accent');
  });

  it('HubLeaderboardTab uses cafe/console tokens, no hub-lb-* CSS vars', () => {
    const src = readSrc('HubLeaderboardTab.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    /* F056: cafe-text-primary → cafe-text (OKLCH token rename) */
    expect(src).toMatch(/cafe-text(?!-)/);
    expect(src).toContain('console-pill-bg');
    expect(src).toContain('cafe-accent');
  });

  it('HubCoCreatorEditor uses console-modal-* tokens, no hub-* CSS vars', () => {
    const src = readSrc('HubCoCreatorEditor.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    expect(src).toContain('console-card-bg');
    expect(src).toContain('console-modal-title');
    expect(src).toContain('console-modal-close-bg');
  });

  it('HubPermissionsTab uses rounded-xl + 0.04 shadow, no hub-* CSS vars', () => {
    const src = readSrc('HubPermissionsTab.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    expect(src).toContain('rounded-xl');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
    expect(src).not.toContain('rounded-2xl');
    expect(src).not.toContain('0_12px_30px');
  });

  it('MemoryNav uses underline tabs matching MissionHub, not soft pills', () => {
    const src = readSrc('memory/MemoryNav.tsx');
    expect(src).toContain('console-divider-b');
    expect(src).toContain('border-b-2 border-[var(--console-button-emphasis)]');
    expect(src).toContain('text-sm font-semibold');
    expect(src).not.toContain('rounded-md');
    expect(src).not.toContain('console-active-bg');
  });

  it('SignalNav uses underline tabs matching MissionHub, not soft pills', () => {
    const src = readSrc('signals/SignalNav.tsx');
    expect(src).toContain('console-divider-b');
    expect(src).toContain('border-b-2 border-[var(--console-button-emphasis)]');
    expect(src).toContain('text-sm font-semibold');
    expect(src).not.toContain('rounded-md');
    expect(src).not.toContain('console-active-bg');
  });

  it('MemoryHub has h1 title header at text-xl', () => {
    const src = readSrc('memory/MemoryHub.tsx');
    expect(src).toMatch(/<h1.*text-xl font-bold/);
  });

  it('DefaultCatSelector has no fixed height, uses shadow', () => {
    const src = readSrc('DefaultCatSelector.tsx');
    expect(src).not.toContain('h-[72px]');
    expect(src).toContain('shadow-[var(--shadow-elevation-2)]');
  });

  it('SettingsRow has default shadow and text-compact font-bold title', () => {
    const src = readSrc('settings/primitives/SettingsRow.tsx');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
    expect(src).toContain('text-compact font-bold');
    expect(src).not.toMatch(/text-sm font-semibold/);
  });

  it('SettingsCard has default shadow', () => {
    const src = readSrc('settings/primitives/SettingsCard.tsx');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
  });

  it('SettingsSection has default shadow', () => {
    const src = readSrc('settings/primitives/SettingsSection.tsx');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
  });

  it('ChatInput default border uses console-border-soft, focus uses console-input-stroke ring', () => {
    const src = readSrc('ChatInput.tsx');
    expect(src).not.toMatch(/border-t border-cafe-subtle/);
    expect(src).toContain('border-[var(--console-border-soft)]');
    expect(src).toContain('focus:ring-[var(--console-input-stroke)]');
  });

  it('PluginsContent shows GitHub config only, no ServiceStatusPanel', () => {
    const src = readSrc('settings/PluginsContent.tsx');
    expect(src).toContain('GitHub');
    expect(src).not.toContain('ServiceStatusPanel');
    expect(src).not.toContain('adaptServiceToPlugin');
  });

  it('SettingsDeleteButton uses HubIcon trash, not inline SVG', () => {
    const src = readSrc('settings/primitives/SettingsDeleteButton.tsx');
    expect(src).toContain('HubIcon');
    expect(src).toContain('name="trash"');
    expect(src).not.toContain('<path');
  });

  it('hub-tag-editor pills have no border, no hub-* CSS vars', () => {
    const src = readSrc('hub-tag-editor.tsx');
    expect(src).not.toMatch(/var\(--hub-/);
    expect(src).not.toMatch(/rounded-full border px/);
    expect(src).toContain('console-runtime-field-bg');
    expect(src).toContain('console-pill-bg');
    expect(src).toContain('conn-purple-bg');
  });

  it('WorkspacePanel aside: no border-l, uses console-panel-bg', () => {
    const src = readSrc('WorkspacePanel.tsx');
    expect(src).not.toMatch(/border-l border-cafe-subtle/);
    expect(src).toMatch(/<aside[\s\S]{0,200}bg-\[var\(--console-panel-bg\)\]/);
  });

  it('SettingsNav item text uses text-compact token, no hardcoded size', () => {
    const src = readSrc('settings/SettingsNav.tsx');
    expect(src).toContain('text-compact');
    expect(src).not.toMatch(/text-\[\d+px\]/);
  });

  it('SettingsDeleteButton: muted default, accent hover with bg', () => {
    const src = readSrc('settings/primitives/SettingsDeleteButton.tsx');
    expect(src).toContain('text-cafe-muted');
    expect(src).toContain('hover:bg-[var(--console-hover-bg)]');
    expect(src).toContain('hover:text-cafe-accent');
    expect(src).not.toMatch(/className=.*text-cafe-accent.*hover/);
  });

  it('SettingsResourceIconButton: muted default for both tones, hover uses accent', () => {
    const src = readSrc('SettingsResourceCard.tsx');
    expect(src).toContain("tone === 'danger'");
    expect(src).toContain('text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent');
    expect(src).not.toMatch(/className=.*text-cafe-accent.*hover/);
  });

  it('HubAccountItem: click-to-edit only, no inline expand/TagEditor', () => {
    const src = readSrc('HubAccountItem.tsx');
    expect(src).not.toContain('TagEditor');
    expect(src).not.toContain('useState');
    expect(src).not.toContain('expanded');
    expect(src).toContain('onEdit');
  });

  it('MissionControlPage h1 has no SVG grid icon', () => {
    const src = readSrc('mission-control/MissionControlPage.tsx');
    expect(src).toMatch(/<h1.*Mission Hub/);
    expect(src).not.toMatch(/<svg[\s\S]*?<rect[\s\S]*?Mission Hub/);
  });

  it('SignalNav is below title, not inline (both views)', () => {
    const inbox = readSrc('signals/SignalInboxView.tsx');
    const sources = readSrc('signals/SignalSourcesView.tsx');
    for (const src of [inbox, sources]) {
      expect(src).not.toMatch(/<h1[\s\S]*?<SignalNav[^>]*\/>\s*<\/div>/);
    }
  });

  it('typography: tokens defined once in JSON, wired into tailwind config + CSS vars via plugin', () => {
    const tokens = JSON.parse(
      readFileSync(resolve(testDir, '..', '..', 'styles', 'typography-tokens.json'), 'utf8'),
    ) as {
      fontSize: Record<string, unknown>;
      fontSizePx: Record<string, unknown>;
    };
    const config = readFileSync(resolve(testDir, '..', '..', '..', 'tailwind.config.js'), 'utf8');
    expect(tokens.fontSize).toHaveProperty('compact');
    expect(tokens.fontSize).toHaveProperty('label');
    expect(tokens.fontSize).toHaveProperty('micro');
    expect(tokens.fontSizePx).toHaveProperty('compact');
    expect(tokens.fontSizePx).toHaveProperty('label');
    expect(config).toContain("require('./src/styles/typography-tokens.json')");
    /* F056: fontSize expanded to object with spread + caption alias;
       verify the spread wiring is intact (not the old direct assignment). */
    expect(config).toContain('...typographyTokens.fontSize');
    expect(config).toContain('--console-font-');
    expect(config).toContain('fontSizePx');
    const css = readFileSync(resolve(testDir, '..', '..', 'app', 'console-shell.css'), 'utf8');
    expect(css).not.toMatch(/--console-font-\w+:\s*\d+px/);
  });

  it('console page titles use text-xl font-bold, not text-2xl', () => {
    for (const [file, tag] of [
      ['memory/MemoryHub.tsx', '记忆'],
      ['signals/SignalInboxView.tsx', '信号'],
      ['signals/SignalSourcesView.tsx', '信号源'],
      ['mission-control/MissionControlPage.tsx', 'Mission Hub'],
    ] as const) {
      const src = readSrc(file);
      expect(src).toContain('text-xl font-bold');
      expect(src).toContain(tag);
    }
  });

  it('Settings hierarchy: page header text-2xl extrabold, section text-base semibold', () => {
    const header = readSrc('settings/SettingsPageHeader.tsx');
    expect(header).toContain('text-2xl font-extrabold');
    const section = readSrc('settings/primitives/SettingsSection.tsx');
    expect(section).toContain('text-base font-semibold');
    expect(section).not.toContain('text-lg font-bold');
  });

  it('divider primitives defined in console-shell.css', () => {
    const css = readFileSync(resolve(testDir, '..', '..', 'app', 'console-shell.css'), 'utf8');
    expect(css).toContain('.console-divider-t');
    expect(css).toContain('.console-divider-b');
    expect(css).toContain('.console-divider-r');
    expect(css).toContain('.console-divider-l');
    expect(css).toMatch(/console-divider-t[\s\S]*?border-top[\s\S]*?var\(--console-border-soft\)/);
  });

  it('MemoryNav + SignalNav use console-divider-b, not raw border pattern', () => {
    for (const file of ['memory/MemoryNav.tsx', 'signals/SignalNav.tsx']) {
      const src = readSrc(file);
      expect(src).toContain('console-divider-b');
      expect(src).not.toMatch(/border-b border-\[var\(--console-border-soft\)\]/);
    }
  });

  it('MissionControlPage tabs use console-divider-b, not raw border pattern', () => {
    const src = readSrc('mission-control/MissionControlPage.tsx');
    expect(src).toContain('console-divider-b');
    expect(src).not.toMatch(/border-b border-\[var\(--console-border-soft\)\]/);
  });

  it('RightStatusPanel section headings use text-cafe (dark), not text-cafe-secondary', () => {
    const src = readSrc('RightStatusPanel.tsx');
    const headingMatches = src.match(/text-label font-bold text-cafe[ "]/g) ?? [];
    expect(headingMatches.length).toBeGreaterThanOrEqual(4);
    expect(src).not.toMatch(/text-label font-bold text-cafe-secondary/);
  });

  it('ThreadSidebar aside has no console-divider-r (resize handle is the visual separator)', () => {
    const src = readSrc('ThreadSidebar/ThreadSidebar.tsx');
    expect(src).not.toMatch(/<aside[^>]*console-divider-r/);
  });

  it('Chat page uses settings-style three-zone colors without a static left separator line', () => {
    const appShell = readSrc('AppShell.tsx');
    const threadSidebar = readSrc('ThreadSidebar/ThreadSidebar.tsx');

    expect(threadSidebar).toContain('bg-[var(--console-panel-bg)]');
    expect(appShell).toContain('label="左侧对话栏"');
    expect(appShell).toContain('showLine={false}');
  });

  it('Chat voice entries stay beside the export action in the conversation header', () => {
    const header = readSrc('ChatContainerHeader.tsx');
    const input = readSrc('ChatInput.tsx');

    expect(header).toContain('<ExportButton threadId={threadId} />');
    expect(header).toContain('<ChatVoiceFeatureControls threadId={threadId} defaultCatId={defaultCatId} />');
    expect(input).not.toContain('ChatVoiceFeatureControls');
  });
});

describe('F190 typography guard — no hardcoded font sizes in console scope', () => {
  const CONSOLE_SCOPE = [
    'settings/SettingsNav.tsx',
    'settings/primitives/SettingsRow.tsx',
    'settings/primitives/SettingsSection.tsx',
    'settings/primitives/SettingsCard.tsx',
    'settings/SettingsPageHeader.tsx',
    'settings/RulesPromptsContent.tsx',
    'settings/SkillPreviewModal.tsx',
    'settings/InstallPreviewModal.tsx',
    'settings/PluginConfigPanel.tsx',
    'settings/PushServiceConfig.tsx',
    'hub-cat-editor-fields.tsx',
    'hub-cat-editor-voice.tsx',
    'hub-cat-editor-advanced.tsx',
    'hub-cat-editor.sections.tsx',
    'hub-tag-editor.tsx',
    'HubCatEditor.tsx',
    'HubCoCreatorEditor.tsx',
    'HubQuotaBoardTab.tsx',
    'HubToolUsageTab.tsx',
    'HubLeaderboardTab.tsx',
    'HubMemberOverviewCard.tsx',
    'RightStatusPanel.tsx',
    'DefaultCatSelector.tsx',
    'memory/MemoryHub.tsx',
    'signals/SignalInboxView.tsx',
    'signals/SignalSourcesView.tsx',
    'mission-control/MissionControlPage.tsx',
    'mission-control/SliceLadder.tsx',
    'mission-control/dag-graph-utils.ts',
    'leaderboard-cards.tsx',
    'leaderboard-phase-bc.tsx',
    'workspace/TerminalTab.tsx',
    'workspace/AgentPaneViewer.tsx',
    'workspace/AgentPaneList.tsx',
    'workspace/JsxPreview.tsx',
    'memory/CollectionGraph.tsx',
    'memory/CollectionGraphParts.tsx',
    'cli-output/CliOutputBlock.tsx',
  ];

  for (const file of CONSOLE_SCOPE) {
    it(`${file}: no hardcoded text-[Xpx] (use tokens: text-micro/label/xs/compact/sm/base/lg/xl)`, () => {
      const src = readSrc(file);
      const matches = src.match(/text-\[\d+px\]/g) ?? [];
      expect(matches).toEqual([]);
    });
  }

  for (const file of CONSOLE_SCOPE) {
    it(`${file}: no inline fontSize in style objects`, () => {
      const src = readSrc(file);
      expect(src).not.toMatch(/fontSize:\s*['"]\d/);
    });
  }

  it('src-wide guard: no raw pixel font definitions outside typography tokens', () => {
    const srcRoot = resolve(testDir, '..', '..');
    /* F056: dev/ tools (OklchTuner) intentionally use dense px sizes */
    const DEV_EXCLUDE = /\/dev\//;
    const violations = collectSourceFiles(srcRoot)
      .filter((file) => !DEV_EXCLUDE.test(file))
      .flatMap((file) => {
        const src = readFileSync(file, 'utf8');
        const matches = [
          ...(src.match(/text-\[\d+(?:\.\d+)?px\]/g) ?? []),
          ...(src.match(/fontSize:\s*['"]?\d/g) ?? []),
          ...(src.match(/fontSize=\{\d/g) ?? []),
          ...(src.match(/font-size:\s*(?:\d|0\.)/g) ?? []),
        ];
        return matches.map((match) => `${file.replace(srcRoot, 'src')}: ${match}`);
      });
    expect(violations).toEqual([]);
  });
});

describe('F190 divider guard — console-scope dividers use semantic class', () => {
  const DIVIDER_SCOPE = [
    'memory/MemoryNav.tsx',
    'signals/SignalNav.tsx',
    'mission-control/MissionControlPage.tsx',
    'settings/primitives/SettingsRow.tsx',
    'settings/primitives/SettingsCollapsibleCard.tsx',
    'settings/capability-settings-ui.tsx',
    'UnifiedAuthModal.tsx',
    'PushSettingsPanel.tsx',
    'ThreadExecutionBar.tsx',
    'ParallelStatusBar.tsx',
    'audit/AuditExplorerPanel.tsx',
    'mission-control/WorkflowSopPanel.tsx',
    'mission-control/FeatureRowList.tsx',
    'workspace/WorldPanel.tsx',
    'PlanBoardPanel.tsx',
    'workspace/ConsolePanel.tsx',
    'workspace/BrowserToolbar.tsx',
    'workspace/BrowserPanel.tsx',
    'workspace/DiffViewer.tsx',
    'rich/DiffBlock.tsx',
    'mission-control/ExternalProjectTab.tsx',
    'mission-control/SliceLadder.tsx',
    'mission-control/ThreadSituationPanel.tsx',
    'memory/CollectionGraphParts.tsx',
    'memory/RecallFeed.tsx',
    'memory/ToolUsageMetricsPanel.tsx',
    'ThreadSidebar/ThreadSidebar.tsx',
    'ThreadSidebar/DirectoryBrowser.tsx',
  ];

  for (const file of DIVIDER_SCOPE) {
    it(`${file}: uses console-divider-* class, no clean raw border-[var(--console-border-soft)]`, () => {
      const src = readSrc(file);
      const rawDividers = src.match(/border-[tbrl] border-\[var\(--console-border-soft\)\]/g) ?? [];
      expect(rawDividers).toEqual([]);
    });
  }
});

describe('#723 Mission Hub — card/border unification guard', () => {
  const MC_CARD_SCOPE = [
    'mission-control/CreateIntentCardForm.tsx',
    'mission-control/IntentCardDetail.tsx',
    'mission-control/ImportProjectModal.tsx',
    'mission-control/SuggestionDecisionPanel.tsx',
    'mission-control/GovernanceHealth.tsx',
    'mission-control/NeedAuditFrame.tsx',
    'mission-control/DispatchProgress.tsx',
    'mission-control/ResolutionQueue.tsx',
    'mission-control/RefluxCapture.tsx',
    'mission-control/RiskPanel.tsx',
    'mission-control/DependencyGraphTab.tsx',
    'mission-control/TranslationMatrix.tsx',
    'mission-control/FeatureBirdEyePanel.tsx',
    'mission-control/ThreadSituationPanel.tsx',
    'mission-control/WorkflowSopPanel.tsx',
    'mission-control/SliceLadder.tsx',
    'mission-control/ExternalProjectTab.tsx',
    'mission-control/QuickCreateForm.tsx',
    'mission-control/FeatureRowList.tsx',
    'mission-control/SuggestionDrawer.tsx',
    'mission-control/MissionControlCard.tsx',
    'mission-control/MissionControlPage.tsx',
  ];

  for (const file of MC_CARD_SCOPE) {
    it(`${file}: no raw "border border-[var(--console-border-soft)]" on containers`, () => {
      const src = readSrc(file);
      const rawCardBorders = src.match(/className="[^"]*\bborder border-\[var\(--console-border-soft\)\][^"]*"/g) ?? [];
      expect(rawCardBorders).toEqual([]);
    });
  }

  it('MissionControlCard uses shadow for main card container', () => {
    const src = readSrc('mission-control/MissionControlCard.tsx');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
    expect(src).not.toMatch(/w-full rounded-xl border p-3/);
  });

  it('Mission Hub inputs use border-transparent + field-bg pattern, no raw border', () => {
    for (const file of [
      'mission-control/CreateIntentCardForm.tsx',
      'mission-control/ImportProjectModal.tsx',
      'mission-control/NeedAuditFrame.tsx',
      'mission-control/SuggestionOpenForm.tsx',
      'mission-control/SuggestionDecisionPanel.tsx',
      'mission-control/ResolutionQueue.tsx',
      'mission-control/RefluxCapture.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).toContain('border-transparent');
      expect(src).toContain('console-field-bg');
      expect(src).not.toContain('border border-[var(--console-border-soft)]');
    }
  });
});

describe('#723 IM connector — typography and card guard', () => {
  it('HubConnectorConfigTab heading uses text-sm font-semibold, not text-base font-extrabold', () => {
    const src = readSrc('HubConnectorConfigTab.tsx');
    expect(src).toContain('text-sm font-semibold');
    expect(src).not.toContain('text-base font-extrabold');
  });

  it('ConfigFieldRenderer inputs use field-bg pattern, not border-cafe', () => {
    const src = readSrc('settings/primitives/ConfigFieldRenderer.tsx');
    expect(src).toContain('console-form-input');
    expect(src).not.toMatch(/border border-cafe rounded-lg/);
  });

  it('ActionRenderer QR card uses shadow, not border', () => {
    const src = readSrc('settings/primitives/ActionRendererParts.tsx');
    expect(src).toContain('shadow-[var(--console-shadow-soft)]');
    expect(src).not.toContain('border border-cafe');
  });
});

describe('#723 cross-page typography consistency', () => {
  it('all console page h1 titles use text-xl font-bold', () => {
    for (const file of [
      'memory/MemoryHub.tsx',
      'signals/SignalInboxView.tsx',
      'signals/SignalSourcesView.tsx',
      'mission-control/MissionControlPage.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).toContain('text-xl font-bold');
    }
  });

  it('all sub-tab navs use text-sm font-semibold', () => {
    for (const file of ['memory/MemoryNav.tsx', 'signals/SignalNav.tsx']) {
      const src = readSrc(file);
      expect(src).toContain('text-sm font-semibold');
    }
  });

  it('settings expand areas (per-cat toggles, sub-sections, rows) have no console-divider-t', () => {
    for (const file of [
      'settings/capability-settings-ui.tsx',
      'settings/primitives/SettingsCollapsibleCard.tsx',
      'settings/primitives/SettingsRow.tsx',
      'settings/PluginConfigPanel.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).not.toContain('console-divider-t');
    }
  });

  it('ChatInput textarea default has soft border and transparent bg, focus shows card-bg', () => {
    const src = readSrc('ChatInput.tsx');
    expect(src).toContain('border-[var(--console-border-soft)] bg-transparent');
    expect(src).toContain('focus:bg-[var(--console-card-bg)]');
  });

  it('homepage inputs (ThreadSidebar search) use deeper bg token, no default border', () => {
    const src = readSrc('ThreadSidebar/ThreadSidebar.tsx');
    expect(src).not.toMatch(/搜索[\s\S]{0,200}bg-\[var\(--console-field-bg\)\]/);
    expect(src).toContain('bg-[var(--console-card-soft-bg)]');
    expect(src).not.toMatch(/搜索[\s\S]{0,80}border border-/);
  });

  it('MessageNavigator has 1px connecting rail, no extra viewport thumb or raw grey', () => {
    const src = readSrc('MessageNavigator.tsx');
    expect(src).toContain('w-px');
    expect(src).toContain('console-border-soft');
    expect(src).not.toContain('w-1.5');
    expect(src).not.toContain('opacity-40');
    expect(src).not.toContain('bg-gray-200');
    expect(src).not.toContain('bg-gray-300/50');
    expect(src).not.toContain('viewport');
  });

  it('chat container keeps a visible thin scrollbar for position context', () => {
    const css = readFileSync(resolve(testDir, '../../app/console-shell.css'), 'utf8');
    const chatRules = css.match(/\[data-chat-container\][\s\S]*?\[data-theme="dark"\]/)?.[0] ?? '';
    expect(css).toContain('[data-chat-container]');
    expect(css).toContain('scrollbar-width: thin');
    expect(css).toContain('[data-chat-container]::-webkit-scrollbar-thumb');
    expect(chatRules).not.toContain('scrollbar-width: none');
    expect(chatRules).not.toContain('display: none');
  });

  it('PushSettingsPanel uses resource-card shell and embeds PushServiceConfig content', () => {
    const src = readSrc('PushSettingsPanel.tsx');
    expect(src).toContain('settingsResourceCardClass');
    expect(src).toContain('settingsResourceRowClass');
    expect(src).toContain('<PushServiceConfig embedded />');
    expect(src).not.toContain('CARD_SHADOW');
  });

  it('interactive icon buttons use muted default, accent hover', () => {
    for (const file of ['settings/primitives/SettingsIconButton.tsx', 'settings/primitives/SettingsDeleteButton.tsx']) {
      const src = readSrc(file);
      expect(src).toContain('text-cafe-muted');
      expect(src).toContain('hover:text-cafe-accent');
      expect(src).not.toMatch(/className=.*text-cafe-accent.*hover/);
    }
  });

  it('light mode --console-field-bg is light, distinct from --console-hover-bg, and not old #f0e6dc', () => {
    /* F056: token definitions moved from console-shell.css to console-tokens.css
     * + theme-tokens.css using OKLCH. Verify the token chain instead of hex. */
    const consoleCss = readFileSync(resolve(testDir, '../../app/console-tokens.css'), 'utf8');
    const themeCss = readFileSync(resolve(testDir, '../../app/theme-tokens.css'), 'utf8');
    /* F056: field-bg aliases to cafe-surface (was cafe-surface-sunken pre-OKLCH) */
    expect(consoleCss).toMatch(/--console-field-bg:\s*var\(--cafe-surface\)/);
    /* hover-bg uses a different recipe (color-mix with accent) */
    expect(consoleCss).toMatch(/--console-hover-bg:\s*color-mix/);
    /* surface-sunken in light is oklch(0.92 ...) — L > 0.9 = bright */
    const sunkenMatch = themeCss.match(/:root[\s\S]*?--cafe-surface-sunken:\s*oklch\((\d+\.?\d*)/);
    if (!sunkenMatch) throw new Error('--cafe-surface-sunken OKLCH L not found in theme-tokens');
    const lightness = Number.parseFloat(sunkenMatch[1]);
    expect(lightness).toBeGreaterThan(0.9);
    /* Ensure no old deprecated hex value */
    expect(consoleCss).not.toContain('#f0e6dc');
    expect(themeCss).not.toContain('#f0e6dc');
  });
});

describe('#723 interactive button guard — no grey pill on action/toggle controls', () => {
  it('ExportButton: no console-pill-bg on the toggle button', () => {
    const src = readSrc('ExportButton.tsx');
    expect(src).not.toContain('console-pill-bg');
    expect(src).toContain('bg-transparent');
  });

  it('VoiceCompanionButton: inactive state has no console-pill-bg', () => {
    const src = readSrc('VoiceCompanionButton.tsx');
    expect(src).not.toContain('console-pill-bg');
    expect(src).toContain('bg-transparent');
  });

  it('ChatVoiceFeatureControls: inactive voice entries have no console-pill-bg', () => {
    const src = readSrc('ChatVoiceFeatureControls.tsx');
    expect(src).not.toContain('console-pill-bg');
    expect(src).toContain('text-cafe-secondary');
  });

  it('ChatContainerHeader: PanelToggle text color in conditional branches, no cascade conflict', () => {
    const src = readSrc('ChatContainerHeader.tsx');
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.includes('function PanelToggle'));
    const fnSrc = lines.slice(start, start + 50).join('\n');
    expect(fnSrc).not.toContain('hover:bg-[var(--console-hover-bg)]');
    expect(fnSrc).toContain('hover:text-cafe-accent');
    const classBase = fnSrc.match(/className=\{`([^$]*)\$/);
    if (classBase) {
      expect(classBase[1]).not.toContain('text-cafe-secondary');
    }
  });

  it('RightStatusPanel: action buttons (toggle/cycle/reveal) have no console-pill class', () => {
    const src = readSrc('RightStatusPanel.tsx');
    expect(src).not.toMatch(/<button[\s\S]*?console-pill/);
  });

  it('HubCoCreatorEditor: upload button has no console-pill-bg', () => {
    const src = readSrc('HubCoCreatorEditor.tsx');
    expect(src).not.toMatch(/<button[\s\S]*?console-pill-bg/);
  });

  it('ThreadSidebar: trash toggle has light bg, not console-code-bg', () => {
    const src = readSrc('ThreadSidebar/ThreadSidebar.tsx');
    expect(src).not.toContain('console-code-bg');
    expect(src).toMatch(/console-hover-bg[\s\S]*?trash-bin-toggle/);
  });
});

describe('#723 round 3 — input/select/stat unification guard', () => {
  it('PushServiceConfig: no right-side status block (公钥/PushService)', () => {
    const src = readSrc('settings/PushServiceConfig.tsx');
    expect(src).not.toContain('公钥：');
    expect(src).not.toContain('PushService：');
  });

  it('EnvSubComponents: default value inline (not separate line), no per-row buildVariableHint', () => {
    const src = readSrc('settings/EnvSubComponents.tsx');
    expect(src).toMatch(/v\.description[\s\S]*?默认: \{v\.defaultValue\}/);
    expect(src).not.toMatch(/<SettingsText[^>]*>[\s\n]*默认: \{v\.defaultValue\}/);
    expect(src).not.toMatch(/buildVariableHint\(v\)\s*\?\s*\(/);
  });

  it('EvidenceSearch selects use console-field-bg + input-stroke focus ring', () => {
    const src = readSrc('memory/EvidenceSearch.tsx');
    const selects = src.match(/<select[\s\S]*?<\/select>/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(4);
    for (const sel of selects) {
      expect(sel).toContain('console-field-bg');
      expect(sel).toContain('focus:ring-1 focus:ring-[var(--console-input-stroke)]');
      expect(sel).not.toContain('console-border-soft');
    }
  });

  it('SignalFilterBar SELECT_CLASS uses console-field-bg + input-stroke focus ring', () => {
    const src = readSrc('signals/SignalFilterBar.tsx');
    expect(src).toContain('bg-[var(--console-field-bg)]');
    expect(src).toContain('focus:ring-1 focus:ring-[var(--console-input-stroke)]');
    expect(src).not.toMatch(/SELECT_CLASS[\s\S]*?console-card-bg/);
  });

  it('SignalFilterBar search wrapper uses console-field-bg, not console-card-bg', () => {
    const src = readSrc('signals/SignalFilterBar.tsx');
    const searchWrapper = src.match(/rounded-lg bg-\[var\(--console-[\w-]+\)\][^"]*focus-within/);
    expect(searchWrapper).not.toBeNull();
    expect(searchWrapper![0]).toContain('console-field-bg');
    expect(searchWrapper![0]).not.toContain('console-card-bg');
  });

  it('SignalArticleList selected state uses console-active-bg, hover uses console-hover-bg', () => {
    const src = readSrc('signals/SignalArticleList.tsx');
    expect(src).toContain('bg-[var(--console-active-bg)]');
    expect(src).toContain('hover:bg-[var(--console-hover-bg)]');
    expect(src).not.toMatch(/selected\s*\?\s*'bg-\[var\(--console-card-bg\)\]/);
  });

  it('HealthReport StatCard value uses text-base font-bold, not text-2xl', () => {
    const src = readSrc('memory/HealthReport.tsx');
    const statCard = src.match(/function StatCard[\s\S]*?^}/m)?.[0] ?? '';
    expect(statCard).toContain('text-base font-bold');
    expect(statCard).not.toContain('text-2xl');
  });

  it('LibraryHealthSection MetricCard value uses text-base font-bold, not text-2xl', () => {
    const src = readSrc('memory/LibraryHealthSection.tsx');
    const metricCard = src.match(/function MetricCard[\s\S]*?^}/m)?.[0] ?? '';
    expect(metricCard).toContain('text-base font-bold');
    expect(metricCard).not.toContain('text-2xl');
  });

  it('EvidenceSearch input uses field-bg + input-stroke focus', () => {
    const src = readSrc('memory/EvidenceSearch.tsx');
    expect(src).toContain('console-field-bg');
    expect(src).not.toContain('bg-transparent');
    expect(src).toContain('focus:ring-[var(--console-input-stroke)]');
    expect(src).not.toContain('formInputClass');
  });

  it('KnowledgeFeed inner tabs use text-xs font-medium, not uppercase tracking-wider', () => {
    const src = readSrc('workspace/KnowledgeFeed.tsx');
    expect(src).toContain('text-xs font-medium');
    expect(src).not.toContain('uppercase tracking-wider');
  });

  it('PushServiceConfig title and description on one line, not separate blocks', () => {
    const src = readSrc('settings/PushServiceConfig.tsx');
    expect(src).toMatch(/VAPID 推送密钥[\s\S]*?保存后写入/);
    expect(src).not.toMatch(/<\/SettingsText>[\s\S]*?<SettingsText[^>]*>[\s\n]*保存后写入/);
  });
});

describe('#723 round 4 — primitive convergence guard', () => {
  it('MarketplaceSearch: no bg-white, no purple focus, no bg-cafe-text chip', () => {
    const src = readSrc('marketplace/marketplace-search.tsx');
    expect(src).not.toContain('bg-white');
    expect(src).not.toContain('focus:border-purple');
    expect(src).not.toContain('focus:ring-purple');
    expect(src).not.toContain('bg-cafe-text');
    expect(src).toContain('console-border-soft');
    expect(src).toContain('console-input-stroke');
    /* F056: text-white → text-[var(--cafe-surface)] for theme-aware contrast */
    expect(src).toContain('bg-cafe-accent text-[var(--cafe-surface)]');
    expect(src).not.toContain('bg-cafe-accent text-white');
  });

  it('SettingsSearchInput uses border-soft + transparent bg + input-stroke focus', () => {
    const src = readSrc('settings/primitives/SettingsToolbar.tsx');
    expect(src).toContain('border-[var(--console-border-soft)]');
    expect(src).toContain('bg-transparent');
    expect(src).toContain('console-input-stroke');
  });

  it('VoiceSettingsPanel inputs use input-stroke focus, not console-border-strong', () => {
    const src = readSrc('VoiceSettingsPanel.tsx');
    expect(src).toContain('console-input-stroke');
    expect(src).not.toContain('console-border-strong');
  });

  it('SettingsNav active: no section.color tinting, uses unified active-bg', () => {
    const src = readSrc('settings/SettingsNav.tsx');
    expect(src).toContain('bg-[var(--console-active-bg)]');
    expect(src).not.toMatch(/color-mix\(in srgb/);
    expect(src).not.toMatch(/color:\s*section\.color/);
  });

  it('SettingsResourceCard uses rounded-xl + 0.04 shadow, matching SettingsRow', () => {
    const src = readSrc('SettingsResourceCard.tsx');
    expect(src).toContain('rounded-xl');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
    expect(src).not.toContain('rounded-2xl');
    expect(src).not.toContain('shadow-[0_12px_30px');
  });

  it('MarketplacePanel calls browse() on mount', () => {
    const src = readSrc('marketplace/marketplace-panel.tsx');
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\n]*browse\(\)/);
  });

  it('MissionControlPage import buttons: visible card-bg, not shell-bg', () => {
    const src = readSrc('mission-control/MissionControlPage.tsx');
    expect(src).not.toMatch(/mc-import[\s\S]*?console-shell-bg/);
    expect(src).toContain('console-card-bg');
  });

  it('QuickCreateForm submit uses cafe-accent, not cafe-text', () => {
    const src = readSrc('mission-control/QuickCreateForm.tsx');
    expect(src).toContain('bg-cafe-accent');
    expect(src).not.toMatch(/bg-\[var\(--cafe-text\)\]/);
  });

  it('VoiceSettingsPanel Section cards match SettingsRow: rounded-xl + 0.04 shadow', () => {
    const src = readSrc('VoiceSettingsPanel.tsx');
    expect(src).toContain('rounded-xl');
    expect(src).not.toMatch(/rounded-2xl[\s\S]*?shadow-\[0_12px/);
  });

  it('MarketplacePanel skeleton uses theme tokens, no bg-white', () => {
    const src = readSrc('marketplace/marketplace-panel.tsx');
    expect(src).not.toContain('bg-white');
    expect(src).not.toContain('border-cafe-border');
  });
});

describe('#723 round 4.1 — deeper primitive convergence guard', () => {
  it('SignalFilterBar: search on first row, selects on second, source has max-w', () => {
    const src = readSrc('signals/SignalFilterBar.tsx');
    expect(src).toMatch(/space-y/);
    expect(src).toMatch(/max-w-\[120px\]/);
  });

  it('ArtifactCard: no bg-white, no border-cafe-border, no purple hover', () => {
    const src = readSrc('marketplace/artifact-card.tsx');
    expect(src).not.toContain('bg-white');
    expect(src).not.toContain('border-cafe-border');
    expect(src).not.toContain('border-purple');
    expect(src).toContain('console-card-bg');
  });

  it('InstallPlanDetail: no bg-white, no border-cafe-border, no blue-600 button', () => {
    const src = readSrc('marketplace/install-plan-detail.tsx');
    expect(src).not.toContain('bg-white');
    expect(src).not.toContain('border-cafe-border');
    expect(src).not.toContain('bg-blue-600');
    expect(src).not.toContain('purple-50');
    expect(src).not.toContain('purple-500');
    expect(src).toContain('bg-cafe-accent');
  });

  it('HubConnectorConfigTab card shells match SettingsRow: rounded-xl + 0.04 shadow', () => {
    const src = readSrc('HubConnectorConfigTab.tsx');
    expect(src).toContain('rounded-xl overflow-hidden shadow-[var(--console-shadow-soft)]');
    expect(src).not.toContain('shadow-[0_12px_30px');
  });
});

describe('#723 round 5 — ops tab/button convergence guard', () => {
  it('OpsContent tabs: active uses Memory underline style, no pill bg', () => {
    const src = readSrc('settings/OpsContent.tsx');
    expect(src).toContain('border-b-2');
    expect(src).toContain('console-button-emphasis');
    expect(src).not.toContain('bg-[var(--console-active-bg)]');
  });

  it('HubObservabilityTab sub-tabs: active uses underline + bold, no pill bg', () => {
    const src = readSrc('HubObservabilityTab.tsx');
    expect(src).not.toContain('bg-conn-blue-bg');
    expect(src).not.toContain('text-blue-700');
    expect(src).not.toContain('text-cafe-accent');
    expect(src).toContain('border-b-2');
    expect(src).toContain('font-semibold');
    expect(src).toContain('console-button-emphasis');
    expect(src).not.toContain('bg-[var(--console-active-bg)]');
  });

  it('DailyUsageSection: no bg-gray-800 button, section uses rounded-xl + 0.04 shadow', () => {
    const src = readSrc('DailyUsageSection.tsx');
    expect(src).not.toContain('bg-gray-800');
    expect(src).not.toContain('bg-gray-700');
    expect(src).not.toContain('rounded-2xl');
    expect(src).not.toContain('shadow-[0_12px_30px');
    expect(src).toContain('rounded-xl');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
  });

  it('HubAgentSessionsTab: refresh accent, secondary buttons card-bg, no cafe-surface/shell-bg', () => {
    const src = readSrc('HubAgentSessionsTab.tsx');
    expect(src).not.toMatch(/rounded bg-cafe-surface hover:bg-cafe-surface-hover/);
    expect(src).not.toContain('console-shell-bg');
    expect(src).not.toMatch(/rounded bg-cafe-surface text-cafe-muted/);
    expect(src).toContain('bg-cafe-accent');
    expect(src).toContain('hover:bg-cafe-accent-hover');
    expect(src).toContain('console-card-bg');
    expect(src).toContain('hover:bg-[var(--console-hover-bg)]');
  });

  it('HubGovernanceTab: no blue refresh link, accent buttons use cafe-accent-hover, px-3 py-1.5 + transition', () => {
    const src = readSrc('HubGovernanceTab.tsx');
    expect(src).not.toContain('text-conn-blue-text hover:text-blue-700');
    expect(src).not.toContain('bg-conn-blue-text');
    expect(src).not.toContain('hover:bg-conn-blue-hover');
    expect(src).toContain('bg-cafe-accent');
    expect(src).toContain('hover:bg-cafe-accent-hover');
    expect(src).not.toContain('text-white');
    expect(src).toContain('px-3 py-1.5');
    expect(src).toContain('transition-colors');
  });

  it('HubRoutingPolicyTab: no bg-blue-600 save, section uses rounded-xl + 0.04 shadow', () => {
    const src = readSrc('HubRoutingPolicyTab.tsx');
    expect(src).not.toContain('bg-blue-600');
    expect(src).toContain('bg-cafe-accent');
    expect(src).toContain('hover:bg-cafe-interactive');
    expect(src).not.toContain('rounded-2xl');
    expect(src).not.toContain('shadow-[0_12px_30px');
    expect(src).toContain('rounded-xl');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
  });

  it('BrakeSettingsPanel: no blue-600 toggle/slider, no indigo info text, card uses rounded-xl', () => {
    const src = readSrc('BrakeSettingsPanel.tsx');
    expect(src).not.toContain('bg-blue-600');
    expect(src).not.toContain('accent-blue-600');
    expect(src).not.toContain('text-indigo-600');
    expect(src).toContain('bg-cafe-accent');
    expect(src).toContain('accent-[var(--cafe-accent)]');
    expect(src).toContain('text-cafe-accent');
    expect(src).not.toMatch(/console-list-card rounded-2xl/);
  });

  it('HubQuotaBoardTab 刷新全部 uses cafe-accent primary, not console-button-emphasis', () => {
    const src = readSrc('HubQuotaBoardTab.tsx');
    expect(src).not.toMatch(/bg-\[var\(--console-button-emphasis\)\][\s\S]*?刷新全部/);
    expect(src).toContain('bg-cafe-accent');
    expect(src).toContain('hover:bg-cafe-interactive');
  });
});

describe('#723 round 6 — select/toggle/button primitive convergence', () => {
  it('formInputClass uses input-stroke focus, not cafe-accent ring', () => {
    const src = readSrc('mcp-form-helpers.tsx');
    expect(src).toContain('focus:ring-[var(--console-input-stroke)]');
    expect(src).not.toContain('focus:ring-cafe-accent');
    expect(src).not.toContain('focus:border-cafe-accent');
  });

  it('EvidenceSearch selects use input-stroke focus, not cafe-accent ring', () => {
    const src = readSrc('memory/EvidenceSearch.tsx');
    const selects = src.match(/<select[\s\S]*?<\/select>/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(4);
    for (const sel of selects) {
      expect(sel).toContain('console-input-stroke');
      expect(sel).not.toContain('cafe-accent/30');
    }
  });

  it('SignalFilterBar: selects + search wrapper use input-stroke, not cafe-accent ring', () => {
    const src = readSrc('signals/SignalFilterBar.tsx');
    expect(src).toContain('console-input-stroke');
    expect(src).not.toContain('cafe-accent/30');
    expect(src).not.toContain('focus:ring-2');
  });

  it('VoiceSettingsPanel select: field-bg background, native arrow (no appearance-none), input-stroke focus', () => {
    const src = readSrc('VoiceSettingsPanel.tsx');
    const selectMatch = src.match(/id="voice-language-select"[\s\S]*?<\/select>/);
    expect(selectMatch).not.toBeNull();
    expect(selectMatch![0]).toContain('console-field-bg');
    expect(selectMatch![0]).not.toContain('appearance-none');
    expect(selectMatch![0]).toContain('console-input-stroke');
  });

  it('DefaultCatSelector select: field-bg background, input-stroke focus', () => {
    const src = readSrc('DefaultCatSelector.tsx');
    expect(src).toContain('console-field-bg');
    expect(src).toContain('console-input-stroke');
    expect(src).not.toContain('console-shell-bg');
    expect(src).not.toContain('focus:ring-cafe-accent');
    expect(src).not.toContain('focus:border-cafe-accent');
  });

  it('hub-cat-editor-fields neutral fields: input-stroke focus, no cafe-accent ring', () => {
    const src = readSrc('hub-cat-editor-fields.tsx');
    expect(src).not.toContain('focus:border-cafe-accent');
    expect(src).not.toContain('focus:ring-cafe-accent/30');
    expect(src).toContain('focus:ring-[var(--console-input-stroke)]');
    expect(src).not.toContain('focus:ring-2');
  });

  it('IndexStatus toggles: cafe-accent for on, no emerald/zinc hardcodes on toggle buttons', () => {
    const src = readSrc('memory/IndexStatus.tsx');
    expect(src).not.toContain('bg-emerald-600');
    expect(src).not.toContain('bg-zinc-400');
    const toggleButtons =
      src.match(/role="switch"[\s\S]*?<\/button>/g) ??
      src.match(/rounded-full transition-colors[\s\S]*?<\/button>/g) ??
      [];
    for (const btn of toggleButtons) {
      expect(btn).not.toContain('bg-conn-green-text');
      expect(btn).not.toContain('bg-gray-300');
    }
    expect(src).toContain('bg-cafe-accent');
  });

  it('Memory secondary buttons: shadow pattern, no border-soft', () => {
    for (const file of ['memory/HealthReport.tsx', 'memory/RebuildButton.tsx', 'memory/IndexStatus.tsx']) {
      const src = readSrc(file);
      const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
      const secondaryButtons = buttons.filter(
        (b) => b.includes('console-card-bg') && b.includes('text-cafe-secondary'),
      );
      for (const btn of secondaryButtons) {
        expect(btn).not.toContain('border-[var(--console-border-soft)]');
        /* F056: raw shadow-[0_1px_3px...] → shadow-sm (tokenized) */
        expect(btn).toContain('shadow-sm');
        expect(btn).not.toMatch(/shadow-\[0_1px_3px/);
      }
    }
  });

  it('CollectionCatalog 新建集合 uses cafe-accent, not cafe-primary', () => {
    const src = readSrc('memory/CollectionCatalog.tsx');
    expect(src).not.toContain('bg-cafe-primary');
    expect(src).toContain('bg-cafe-accent');
  });

  it('CreateCollectionDialog: no border-soft inputs, no blue/cafe-primary buttons, uses field-bg + input-stroke', () => {
    const src = readSrc('memory/CreateCollectionDialog.tsx');
    expect(src).not.toContain('border-[var(--console-border-soft)]');
    expect(src).not.toContain('text-blue-700');
    expect(src).not.toContain('border-blue-300');
    expect(src).not.toContain('bg-blue-50');
    expect(src).not.toContain('text-blue-800');
    expect(src).not.toContain('bg-cafe-primary');
    expect(src).not.toContain('text-red-600');
    expect(src).toContain('console-field-bg');
    expect(src).toContain('console-input-stroke');
    expect(src).toContain('bg-cafe-accent');
  });
});

describe('#723 round 7 — operator visual convergence: tabs, search, selects, buttons, cards', () => {
  it('OpsContent: active tab uses Memory underline (border-b-2 + emphasis)', () => {
    const src = readSrc('settings/OpsContent.tsx');
    expect(src).toContain('border-b-2');
    expect(src).toContain('console-button-emphasis');
    expect(src).not.toContain('bg-[var(--console-active-bg)]');
  });

  it('HubObservabilityTab: sub-tabs use underline + bold, no pill bg', () => {
    const src = readSrc('HubObservabilityTab.tsx');
    expect(src).not.toContain('text-cafe-accent');
    expect(src).toContain('border-b-2');
    expect(src).toContain('font-semibold');
    expect(src).not.toContain('bg-[var(--console-active-bg)]');
  });

  it('HubTraceTree: search input uses field-bg, button accent, no blue', () => {
    const src = readSrc('HubTraceTree.tsx');
    const searchBlock = src.match(/<input[\s\S]*?Search[\s\S]*?<\/button>/);
    expect(searchBlock).not.toBeNull();
    expect(searchBlock![0]).not.toContain('border-cafe-border');
    expect(searchBlock![0]).not.toContain('bg-cafe-surface');
    expect(searchBlock![0]).not.toContain('conn-blue-ring');
    expect(searchBlock![0]).not.toContain('bg-conn-blue-bg');
    expect(searchBlock![0]).toContain('console-field-bg');
    expect(searchBlock![0]).toContain('bg-cafe-accent');
    expect(searchBlock![0]).toContain('hover:bg-cafe-accent-hover');
  });

  it('DependencyGraphTab: scope pills no mc-accent/white, use console-active-bg', () => {
    const src = readSrc('mission-control/DependencyGraphTab.tsx');
    expect(src).not.toMatch(/bg-\[var\(--mc-accent\)\] text-white/);
    expect(src).toContain('bg-[var(--console-active-bg)] font-semibold text-cafe');
  });

  it('MissionControlPage StatusDot: text-xs not text-sm', () => {
    const src = readSrc('mission-control/MissionControlPage.tsx');
    const statusDot = src.match(/function StatusDot[\s\S]*?^}/m);
    expect(statusDot).not.toBeNull();
    expect(statusDot![0]).toContain('text-xs');
    expect(statusDot![0]).not.toContain('text-sm');
  });

  it('InstallPlanDetail: gear tile h-12 w-12, icon h-6 w-6, button not full-width', () => {
    const src = readSrc('marketplace/install-plan-detail.tsx');
    expect(src).toContain('h-12 w-12');
    expect(src).toContain('h-6 w-6 text-cafe-accent');
    expect(src).not.toMatch(/class(?:Name)?="flex w-full/);
  });

  it('EvidenceSearch: search input field-bg no border, button accent with disabled, filter selects self-describing labels', () => {
    const src = readSrc('memory/EvidenceSearch.tsx');
    const searchInput = src.match(/<input[\s\S]*?data-testid="evidence-search-input"[\s\S]*?\/>/);
    expect(searchInput).not.toBeNull();
    expect(searchInput![0]).not.toContain('border-[var(--console-border-soft)]');
    expect(searchInput![0]).not.toContain('bg-transparent');
    expect(searchInput![0]).toContain('console-field-bg');
    const searchBtn = src.match(/<button[\s\S]*?data-testid="evidence-search-button"[\s\S]*?<\/button>/);
    expect(searchBtn).not.toBeNull();
    expect(searchBtn![0]).toContain('bg-cafe-accent');
    expect(searchBtn![0]).toContain('disabled:opacity-50');
    expect(src).toContain('混合检索');
    expect(src).toContain('全部维度');
    expect(src).toContain('全部范围');
    expect(src).toContain('仅摘要');
  });

  it('All selects: no appearance-none (native arrow visible)', () => {
    for (const file of ['signals/SignalFilterBar.tsx', 'VoiceSettingsPanel.tsx']) {
      const src = readSrc(file);
      expect(src).not.toContain('appearance-none');
    }
    const eSrc = readSrc('memory/EvidenceSearch.tsx');
    expect(eSrc).not.toContain('appearance-none');
    const cdSrc = readSrc('memory/CreateCollectionDialog.tsx');
    const cdSelects = cdSrc.match(/<select[\s\S]*?<\/select>/g) ?? [];
    for (const sel of cdSelects) {
      expect(sel).not.toContain('appearance-none');
    }
  });

  it('CollectionCatalog action buttons: secondary shadow, no border-soft micro pill', () => {
    const src = readSrc('memory/CollectionCatalog.tsx');
    const actionButtons = (src.match(/<button[\s\S]*?<\/button>/g) ?? []).filter(
      (b) => b.includes('rebuild-') || b.includes('archive-') || b.includes('unarchive-'),
    );
    for (const btn of actionButtons) {
      expect(btn).not.toContain('border-[var(--console-border-soft)]');
      expect(btn).not.toContain('text-micro');
      expect(btn).toContain('shadow-[0_1px_3px');
      expect(btn).toContain('rounded-lg');
    }
  });

  it('HubConnectorConfigTab: platform card header uses resource-card sizing, not custom h-11/px-5', () => {
    const src = readSrc('HubConnectorConfigTab.tsx');
    expect(src).not.toContain('h-11 w-11');
    expect(src).not.toContain('px-5 py-[18px]');
    expect(src).toContain('h-9 w-9');
    expect(src).toContain('px-4 py-3');
  });

  it('SettingsCollapsibleCard: rounded-xl + 0.04 shadow, not rounded-2xl or 0.05', () => {
    const src = readSrc('settings/primitives/SettingsCollapsibleCard.tsx');
    expect(src).not.toContain('rounded-2xl');
    expect(src).not.toContain('0.05)');
    expect(src).toContain('rounded-xl');
    expect(src).toContain('shadow-[0_8px_22px_rgba(43,33,26,0.04)]');
  });

  it('McpManageContent: skeleton uses Tailwind classes, not inline style for card shell', () => {
    const src = readSrc('settings/McpManageContent.tsx');
    const skeleton = src.match(/animate-pulse[\s\S]*?<\/div>\s*<\/div>/);
    expect(skeleton).not.toBeNull();
    expect(skeleton![0]).toContain('rounded-xl');
    expect(skeleton![0]).not.toMatch(/style=.*borderRadius/);
  });

  it('InstallPlanDetail: disabled (direct_mcp) button uses neutral secondary, not accent', () => {
    const src = readSrc('marketplace/install-plan-detail.tsx');
    expect(src).toContain('cursor-not-allowed');
    expect(src).toMatch(/canAct[\s\S]*?bg-cafe-accent[\s\S]*?console-card-bg[\s\S]*?cursor-not-allowed/);
    expect(src).not.toMatch(/!canAct[\s\S]{0,50}bg-cafe-accent/);
  });

  it('MissionControlPage tabs: no underline/emphasis, use rounded-lg active-bg', () => {
    const src = readSrc('mission-control/MissionControlPage.tsx');
    expect(src).not.toContain('border-b-2');
    expect(src).not.toContain('console-button-emphasis');
    expect(src).toContain("rounded-lg bg-[var(--console-active-bg)] text-cafe'");
    expect(src).toContain('hover:bg-[var(--console-hover-bg)]');
  });
});

describe('#723 round 8 — operator: refresh button, ops underline tabs, service toggle state machine', () => {
  it('HubGovernanceTab refresh: standard secondary pattern (px-3 py-1.5 + transition-colors)', () => {
    const src = readSrc('HubGovernanceTab.tsx');
    const refreshBtn = src.match(/<button[^>]*onClick=\{fetchHealth\}[^>]*>/);
    expect(refreshBtn).not.toBeNull();
    expect(refreshBtn![0]).toContain('px-3 py-1.5');
    expect(refreshBtn![0]).toContain('transition-colors');
  });

  it('OpsContent tabs: Memory underline style (border-b-2 + emphasis), no pill bg', () => {
    const src = readSrc('settings/OpsContent.tsx');
    expect(src).toContain('border-b-2');
    expect(src).toContain('border-[var(--console-button-emphasis)]');
    expect(src).toContain('text-[var(--console-button-emphasis)]');
    expect(src).not.toContain('bg-[var(--console-active-bg)]');
    expect(src).not.toContain('rounded-lg');
  });

  it('HubObservabilityTab sub-tabs: underline style, no pill bg or rounded-lg', () => {
    const src = readSrc('HubObservabilityTab.tsx');
    expect(src).toContain('border-b-2');
    expect(src).toContain('console-button-emphasis');
    expect(src).not.toContain('bg-[var(--console-active-bg)]');
    const subtabButtons = src.match(/className=\{`[^`]*subTab[^`]*`\}/g) ?? [];
    for (const btn of subtabButtons) {
      expect(btn).not.toContain('rounded-lg');
    }
  });

  it('ServiceStatusPanel: toggle-based state machine with explicit installed/enabled state, no availableActions', () => {
    const src = readSrc('settings/ServiceStatusPanel.tsx');
    expect(src).toContain('SettingsResourceToggleSwitch');
    expect(src).toContain('service.installed');
    expect(src).toContain('service.installable');
    expect(src).toContain('handleToggle');
    expect(src).not.toMatch(/ACTION_CONFIG/);
    expect(src).not.toContain('availableActions');
    expect(src).not.toContain('installedKnown');
    expect(src).toContain("'安装'");
  });

  it('service-ui-adapter: no availableActions type or passthrough', () => {
    const src = readSrc('settings/service-ui-adapter.ts');
    expect(src).not.toContain('availableActions');
    expect(src).not.toContain('HomeServiceAction');
    expect(src).toContain('installed: boolean');
    expect(src).toContain('enabled: boolean');
    expect(src).toContain('installable: boolean');
  });
});

describe('#723 round 8.2 — toggle uses enabled (not running), adapter preserves explicit fields', () => {
  it('ServiceStatusPanel toggle reads service.enabled, not service.running', () => {
    const src = readSrc('settings/ServiceStatusPanel.tsx');
    expect(src).toContain('enabled={service.enabled}');
    expect(src).not.toContain('enabled={service.running}');
    expect(src).toContain('!service.enabled');
    expect(src).not.toMatch(/!service\.running/);
  });

  it('service-ui-adapter does not override installed/enabled from health status', () => {
    const src = readSrc('settings/service-ui-adapter.ts');
    expect(src).toContain('const installed = home.installed');
    expect(src).toContain('const enabled = home.enabled');
    expect(src).not.toMatch(/installed\s*=\s*true/);
    expect(src).not.toMatch(/enabled\s*=\s*true/);
  });
});

describe('#723 round 9 — install button, error suppression, breadcrumb, tab/card convergence', () => {
  it('ServiceStatusPanel install: accent button with disabled, not SettingsBadge', () => {
    const src = readSrc('settings/ServiceStatusPanel.tsx');
    expect(src).not.toContain('SettingsBadge');
    expect(src).toContain("'安装'");
    expect(src).toContain('bg-cafe-accent');
    expect(src).toContain('hover:bg-cafe-accent-hover');
    expect(src).not.toContain('text-white');
    expect(src).toContain('disabled:opacity-50');
    expect(src).toContain('transition-colors');
  });

  it('service-ui-adapter suppresses error when not installed or not enabled', () => {
    const src = readSrc('settings/service-ui-adapter.ts');
    expect(src).toContain('(installed && enabled) || !home.installable ? home.error');
  });

  it('HubPermissionsTab: no breadcrumb separator', () => {
    const src = readSrc('HubPermissionsTab.tsx');
    expect(src).not.toContain('›');
    expect(src).not.toMatch(/connectorLabel.*群聊权限/);
  });

  it('KnowledgeFeed tabs: underline emphasis tokens, no cafe-accent tab styling', () => {
    const src = readSrc('workspace/KnowledgeFeed.tsx');
    expect(src).toContain('console-button-emphasis');
    expect(src).not.toMatch(/text-cafe-accent.*border/);
    expect(src).not.toContain('bg-cafe-accent text-white');
  });

  it('HubToolUsageTab: dataviz tokens, no inline hex in CATEGORY_STYLE values', () => {
    const src = readSrc('HubToolUsageTab.tsx');
    expect(src).toContain('DATAVIZ_TOKENS');
    expect(src).toContain('var(--dataviz-native)');
    expect(src).not.toMatch(/color: '#[0-9A-Fa-f]{6}'/);
    expect(src).not.toContain('rounded-2xl');
    expect(src).not.toContain('0_12px_30px');
  });

  it('HubObservabilityTab chart stroke: CSS variable, not raw hex', () => {
    const src = readSrc('HubObservabilityTab.tsx');
    expect(src).toContain('var(--dataviz-trend-line)');
    expect(src).not.toMatch(/stroke="#[0-9A-Fa-f]{6}"/);
  });

  it('visible Settings primitives: rounded-xl (modals exempt)', () => {
    for (const file of [
      'settings/primitives/SettingsSection.tsx',
      'settings/primitives/SettingsToolbar.tsx',
      'settings/PushDiagnosticsSection.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).not.toContain('rounded-2xl');
    }
  });

  it('DefaultCatSelector: rounded-xl + standard shadow', () => {
    const src = readSrc('DefaultCatSelector.tsx');
    expect(src).toContain('rounded-xl');
    expect(src).not.toContain('rounded-[14px]');
    expect(src).not.toContain('0_12px_30px');
  });

  it('modals keep rounded-2xl (whitelisted elevation)', () => {
    for (const file of ['settings/InstallPreviewModal.tsx', 'settings/SkillPreviewModal.tsx']) {
      const src = readSrc(file);
      expect(src).toContain('rounded-2xl');
    }
  });

  it('console modal scrims consistently blur the page behind them', () => {
    const modalOverlayFiles = [
      'Lightbox.tsx',
      'VoteConfigModal.tsx',
      'MessageActions.tsx',
      'UnifiedAuthModal.tsx',
      'BrakeModal.tsx',
      'HubListModal.tsx',
      'memory/CreateCollectionDialog.tsx',
      'ConfirmDialog.tsx',
      'mission-control/ImportProjectModal.tsx',
      'BootcampListModal.tsx',
      'MobileStatusSheet.tsx',
      'ChatContainer.tsx',
      'first-run-quest/BootcampGuideOverlay.tsx',
      'HubCoCreatorEditor.tsx',
      'FirstRunQuestWizard.tsx',
      'settings/InstallPreviewModal.tsx',
      'settings/SkillPreviewModal.tsx',
      'guide-overlay/GuideOverlayCompletion.tsx',
      'HubCatEditor.tsx',
      'McpConfigModal.tsx',
      'SteerQueuedEntryModal.tsx',
      'ThreadSidebar/DirectoryPickerModal.tsx',
      'ThreadSidebar/ThreadSidebar.tsx',
      'ThreadSidebar/ThreadOrganizerModal.tsx',
    ];

    for (const file of modalOverlayFiles) {
      const src = readSrc(file);
      const overlayClassNames = [
        ...src.matchAll(
          /className=(?:"([^"]*bg-\[var\(--console-overlay-(?:backdrop|medium|light|heavy)\)\][^"]*)"|\{`([^`]*bg-\[var\(--console-overlay-(?:backdrop|medium|light|heavy)\)\][^`]*)`\})/g,
        ),
      ]
        .map((match) => match[1] ?? match[2])
        .filter((className) => className.includes('inset-0'));

      expect(overlayClassNames, `${file} should declare at least one console overlay scrim`).not.toHaveLength(0);
      for (const className of overlayClassNames) {
        expect(className, `${file} overlay scrim should include backdrop-blur-sm`).toContain('backdrop-blur-sm');
      }
    }
  });

  it('HubQuotaBoardTab: rounded-xl + standard shadow, no heavy shadow', () => {
    const src = readSrc('HubQuotaBoardTab.tsx');
    expect(src).not.toContain('rounded-2xl');
    expect(src).not.toContain('0_12px_30px');
  });

  it('DailyUsageSection refresh: accent button (py-1.5 + transition-colors)', () => {
    const src = readSrc('DailyUsageSection.tsx');
    expect(src).toContain('bg-cafe-accent');
    expect(src).toContain('hover:bg-cafe-accent-hover');
    expect(src).not.toContain('text-white');
    expect(src).toContain('py-1.5');
    expect(src).toContain('transition-colors');
  });
});
