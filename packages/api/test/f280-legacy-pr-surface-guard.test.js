import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoots = ['packages/api/src', 'packages/mcp-server/src', 'packages/shared/src'];
const legacyFieldPattern = /\b(wakePolicy|trackingInstructions|eventWait|detectEventCallback)\b/g;

const allowedRegions = [
  {
    path: 'packages/shared/src/types/task.ts',
    label: 'LegacyIssueAutomationState',
    start: 'export interface LegacyIssueAutomationState',
    end: 'export type AutomationState',
  },
  {
    path: 'packages/mcp-server/src/tools/callback-tools.ts',
    label: 'registerIssueTrackingInputSchema + handleRegisterIssueTracking',
    start: 'export const registerIssueTrackingInputSchema',
    end: 'export const unregisterTrackingInputSchema',
  },
  {
    path: 'packages/api/src/routes/callbacks.ts',
    label: 'register-issue-tracking route',
    start: 'const registerIssueTrackingSchema',
    end: "app.post('/api/callbacks/unregister-tracking'",
  },
  {
    path: 'packages/api/src/infrastructure/email/IssueCommentRouter.ts',
    label: 'IssueCommentRouter',
    start: 'export class IssueCommentRouter',
    end: '// ── Message Formatting',
  },
  {
    path: 'packages/api/src/infrastructure/email/IssueCommentRouter.ts',
    label: 'buildIssueCommentContent',
    start: 'export function buildIssueCommentContent',
    end: undefined,
  },
  {
    path: 'packages/api/src/infrastructure/email/IssueCommentTaskSpec.ts',
    label: 'shouldDeliverComment',
    start: 'function shouldDeliverComment',
    end: 'export function createIssueCommentTaskSpec',
  },
  {
    path: 'packages/api/src/infrastructure/email/IssueCommentTaskSpec.ts',
    label: 'createIssueCommentTaskSpec',
    start: 'export function createIssueCommentTaskSpec',
    end: undefined,
  },
  {
    path: 'packages/api/src/domains/community/community-delivery-policy.ts',
    label: 'TrackingWakePolicyInput',
    start: 'export interface TrackingWakePolicyInput',
    end: '// ---------------------------------------------------------------------------\n// Rule constants',
  },
  {
    path: 'packages/api/src/domains/community/community-delivery-policy.ts',
    label: 'decideTrackingWake',
    start: 'export function decideTrackingWake',
    end: undefined,
  },
  {
    path: 'packages/api/src/domains/cats/services/stores/ports/TaskAutomationState.ts',
    label: 'mergeTaskAutomationState issue compatibility seam',
    start: 'export function mergeTaskAutomationState',
    end: undefined,
  },
  {
    path: 'packages/api/src/domains/ball-custody/PrWaitMigrationService.ts',
    label: 'one-time atomic PR legacy migration',
    start: 'const LEGACY_KEYS',
    end: undefined,
  },
  {
    path: 'packages/api/src/domains/cats/services/agents/routing/route-serial.ts',
    label: 'structured custody stop-gate vocabulary',
    start: 'const TURN_CUSTODY_STOP_GATE_REMEDIAL_PROMPT',
    end: '/**\n * F233 Phase B (B2): persist ball.handed',
  },
];

function sourceFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function bounds(source, region) {
  const start = source.indexOf(region.start);
  assert.notEqual(start, -1, `${region.path}: missing allowlist start for ${region.label}`);
  const end = region.end === undefined ? source.length : source.indexOf(region.end, start + region.start.length);
  assert.notEqual(end, -1, `${region.path}: missing allowlist end for ${region.label}`);
  return { start, end };
}

describe('F280 legacy PR surface guard', () => {
  it('allows legacy fields only in exact issue symbols and the one-time migration module', () => {
    const files = sourceRoots.flatMap((root) => sourceFiles(resolve(repoRoot, root)));
    const hits = [];
    for (const path of files) {
      const source = readFileSync(path, 'utf8');
      const relativePath = relative(repoRoot, path);
      for (const match of source.matchAll(legacyFieldPattern)) {
        hits.push({ path: relativePath, field: match[1], offset: match.index, source });
      }
    }

    const usedRegions = new Set();
    const unexpected = hits.filter((hit) => {
      const regions = allowedRegions.filter((region) => region.path === hit.path);
      for (const region of regions) {
        const range = bounds(hit.source, region);
        if (hit.offset >= range.start && hit.offset < range.end) {
          usedRegions.add(`${region.path}:${region.label}`);
          return false;
        }
      }
      return true;
    });

    assert.deepEqual(
      unexpected.map(({ path, field, source, offset }) => ({
        path,
        field,
        line: source.slice(0, offset).split('\n').length,
      })),
      [],
      'unknown legacy PR surface appeared; add no broad file allowlist',
    );
    for (const region of allowedRegions) {
      assert.equal(
        usedRegions.has(`${region.path}:${region.label}`),
        true,
        `stale allowlist region: ${region.path}#${region.label}`,
      );
    }
  });

  it('PrAutomationState itself contains no legacy PR key', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/shared/src/types/task.ts'), 'utf8');
    const start = source.indexOf('export interface PrAutomationState');
    const end = source.indexOf('export type IssueTrackingWakePolicy', start);
    const prState = source.slice(start, end);
    assert.doesNotMatch(prState, /\b(intent|wakePolicy|trackingInstructions|eventWait)\b/);
  });
});
