import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ProseMigration {
  path: string;
  legacy: string;
  contract?: 'CompactLabel' | 'ExpandableProse' | 'LongFormReader';
}

const PROSE_MIGRATIONS: ProseMigration[] = [
  { path: '../ChatInputActionButton.tsx', legacy: 'max-w-[240px] truncate' },
  { path: '../first-run-quest/TemplateStep.tsx', legacy: 'line-clamp-1 text-xs text-cafe-muted' },
  { path: '../marketplace/artifact-card.tsx', legacy: 'line-clamp-2 text-xs leading-relaxed' },
  {
    path: '../mission-control/DependencyGraphTab.tsx',
    legacy: 'line-clamp-2 text-xs leading-snug',
    contract: 'CompactLabel',
  },
  { path: '../mission-control/MissionControlCard.tsx', legacy: 'line-clamp-2 text-xs leading-relaxed' },
  { path: '../mission-control/RiskPanel.tsx', legacy: 'truncate text-cafe' },
  {
    path: '../QueueEntryRow.tsx',
    legacy: 'text-sm text-cafe-secondary truncate',
    contract: 'LongFormReader',
  },
  { path: '../settings/CatDossierContent.tsx', legacy: 'mt-0.5 line-clamp-2' },
  { path: '../VoteActiveBar.tsx', legacy: 'text-conn-amber-text truncate flex-1' },
  { path: '../WhisperCatSelector.tsx', legacy: 'text-xs text-cafe-muted truncate' },
  { path: '../workspace/GitPanel.tsx', legacy: 'truncate text-cafe-black/80 flex-1' },
  { path: '../workspace/HealthDashboard.tsx', legacy: '<span className="truncate">{c.subject}</span>' },
  { path: '../workspace/SchedulePanel.tsx', legacy: 'text-cafe-secondary truncate max-w-[140px]' },
  { path: '../workspace/WorldPanel.tsx', legacy: 'String(ev.payload.content).slice(0, 200)' },
];

const PRODUCER_MIGRATIONS = [
  {
    path: '../../hooks/useAgentMessages.ts',
    legacy: "preview.slice(0, 80) + (preview.length > 80 ? '...' : '')",
    recovery: 'message: preview',
  },
  {
    path: '../../stores/chatStore.ts',
    legacy: "msg.content.replace(/\\n/g, ' ').slice(0, 120)",
    recovery: 'notification.onclick',
  },
  {
    path: '../story-player/ReplayEventBubble.tsx',
    legacy: 'event.toolResult.slice(0, 2000)',
    recovery: '<LongFormReader',
  },
  {
    path: '../../lib/story-player/cross-feature-detector.ts',
    legacy: 'rawContent.slice(0, MAX_SNIPPET_LENGTH)',
    recovery: 'contentSnippet: rawContent',
  },
  {
    path: '../rich/CardBlock.tsx',
    legacy: 'm.content?.slice(0, 200)',
    recovery: "m.content ?? ''",
  },
];

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('F269 U1 prose recovery source contract', () => {
  for (const migration of PROSE_MIGRATIONS) {
    it(`${migration.path} uses the shared recovery contract`, () => {
      const text = source(migration.path);
      expect(text).not.toContain(migration.legacy);
      expect(text).toContain(migration.contract ?? 'ExpandableProse');
    });
  }

  for (const migration of PRODUCER_MIGRATIONS) {
    it(`${migration.path} preserves or drills to canonical content`, () => {
      const text = source(migration.path);
      expect(text).not.toContain(migration.legacy);
      expect(text).toContain(migration.recovery);
    });
  }
});
