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
    path: 'packages/api/src/domains/ball-custody/PrWaitMigrationService.ts',
    label: 'one-time atomic PR legacy migration',
    start: 'const LEGACY_KEYS',
    end: undefined,
  },
  {
    path: 'packages/api/src/domains/ball-custody/IssueWaitMigrationService.ts',
    label: 'one-time atomic issue legacy migration',
    start: 'const LEGACY_KEYS',
    end: undefined,
  },
  {
    path: 'packages/api/src/domains/cats/services/agents/routing/route-serial.ts',
    label: 'structured custody stop-gate vocabulary',
    start: 'export function buildTurnCustodyStopGateRemedialPrompt',
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

describe('F280 legacy wait surface guard', () => {
  it('allows legacy fields only in exact one-time migration modules and custody vocabulary', () => {
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

  it('typed PR and issue automation states contain no legacy wait key', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/shared/src/types/task.ts'), 'utf8');
    const prStart = source.indexOf('export interface PrAutomationState');
    const issueStart = source.indexOf('export interface IssueWaitAutomationState');
    const issueEnd = source.indexOf('export type AutomationState', issueStart);
    assert.notEqual(prStart, -1);
    assert.notEqual(issueStart, -1);
    assert.notEqual(issueEnd, -1);
    const prState = source.slice(prStart, issueStart);
    const issueState = source.slice(issueStart, issueEnd);
    assert.doesNotMatch(prState, /\b(intent|wakePolicy|trackingInstructions|eventWait)\b/);
    assert.doesNotMatch(issueState, /\b(intent|wakePolicy|trackingInstructions|eventWait)\b/);
  });
});
