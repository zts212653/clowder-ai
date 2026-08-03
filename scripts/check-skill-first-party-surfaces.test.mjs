import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadAllowlist, scanSkillSurfaceText } from './check-skill-first-party-surfaces.mjs';

const REL_PATH = 'cat-cafe-skills/workspace-navigator/SKILL.md';
const INBOUND_RUNBOOK_URL = new URL('../cat-cafe-skills/refs/opensource-ops-inbound-pr.md', import.meta.url);

function scan(content, allowlist = []) {
  return scanSkillSurfaceText(content, REL_PATH, allowlist);
}

describe('check-skill-first-party-surfaces', () => {
  it(
    'keeps open-source intake gate claims aligned with the live package check surface',
    { skip: !existsSync(INBOUND_RUNBOOK_URL) && 'home-only maintainer runbook is absent from public export' },
    () => {
      const reference = readFileSync(INBOUND_RUNBOOK_URL, 'utf8');
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

      assert.match(reference, /`pnpm gate`/);
      assert.match(reference, /`pnpm check`/);
      assert.doesNotMatch(reference, /PARALLEL_CHECKS/);
      for (const sunsetAlias of ['check:settings-primitives', 'check:source-hygiene']) {
        assert.equal(pkg.scripts[sunsetAlias], undefined, `${sunsetAlias} is expected to remain sunset`);
        assert.doesNotMatch(
          reference,
          new RegExp(`\\b${sunsetAlias.replace(':', '\\:')}\\b`),
          `live skill reference must not claim ${sunsetAlias} runs in pnpm gate`,
        );
      }
    },
  );

  it('keeps writing-plans formatting steps executable and source-derived', () => {
    const skill = readFileSync(new URL('../cat-cafe-skills/writing-plans/SKILL.md', import.meta.url), 'utf8');

    assert.match(skill, /## Formatting Command Contract/);
    assert.match(skill, /`pnpm check:fix`/);
    assert.match(skill, /`pnpm biome format --write <files>`/);
    assert.match(skill, /`pnpm check`/);
    assert.match(skill, /先从当前仓库的 `package\.json`、CI 或现有脚本确认/);
    assert.match(skill, /禁止只写[“"](?:run formatting|格式化)[”"]/);
  });

  it('blocks raw workspace navigate curl guidance', () => {
    const hits = scan(`
Use this command:

\`\`\`bash
curl -X POST http://localhost:3004/api/workspace/navigate \\
  -H 'Content-Type: application/json' \\
  -d '{"worktreeId":"cat-cafe","path":"docs/foo.md","action":"open"}'
\`\`\`
`);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 5);
  });

  it('blocks scheme-less localhost curl guidance', () => {
    const hits = scan(`
\`\`\`bash
curl -X POST localhost:3004/api/workspace/navigate \\
  -d '{"worktreeId":"cat-cafe","path":"docs/foo.md","action":"open"}'
\`\`\`
`);
    assert.equal(hits.length, 1);
  });

  it('blocks multiline preview auto-open curl guidance', () => {
    const hits = scan(`
\`\`\`bash
curl -sS -X POST \\
  "$CAT_CAFE_API_URL/api/preview/auto-open" \\
  -d '{"port":5102}'
\`\`\`
`);
    assert.equal(hits.length, 1);
  });

  it('allows typed MCP guidance', () => {
    const hits = scan(`
\`\`\`ts
await cat_cafe_workspace_navigate({ worktreeId: 'cat-cafe', path: 'docs/foo.md', action: 'open' });
\`\`\`
`);
    assert.deepEqual(hits, []);
  });

  it('allows generic localhost health probes', () => {
    const hits = scan(`
\`\`\`bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT
\`\`\`
`);
    assert.deepEqual(hits, []);
  });

  it('allows negative guidance that warns against raw curl', () => {
    const hits = scan('不要手写 `/api/preview/auto-open` 的 `curl`，主路径是 `cat_cafe_preview_open`。');
    assert.deepEqual(hits, []);
  });

  it('allows explicit instead-of-raw-curl guidance', () => {
    const hits = scan(
      'Use `cat_cafe_workspace_navigate` instead of raw curl to `localhost:3004/api/workspace/navigate`.',
    );
    assert.deepEqual(hits, []);
  });

  it('blocks positive fallback guidance that says to run raw curl instead', () => {
    const hits = scan(`
If the MCP tool is unavailable, run this instead:
curl -X POST localhost:3004/api/workspace/navigate \\
  -d '{"worktreeId":"cat-cafe","path":"docs/foo.md","action":"open"}'
`);
    assert.equal(hits.length, 1);
  });

  it('honors reviewed allowlist entries', () => {
    const hits = scan('curl -X POST http://localhost:3004/api/workspace/navigate', [
      { path: REL_PATH, pattern: 'http://localhost:3004/api/workspace/navigate', reason: 'fixture' },
    ]);
    assert.deepEqual(hits, []);
  });

  it('fails closed when allowlist is missing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'skill-surface-missing-allowlist-'));
    assert.throws(() => loadAllowlist(repo), /allowlist missing/i);
  });

  it('fails closed when allowlist entries are malformed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'skill-surface-malformed-allowlist-'));
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts/check-skill-first-party-surfaces.allowlist.json'),
      JSON.stringify({ allow: [{ path: REL_PATH, pattern: 'x' }] }),
    );
    assert.throws(() => loadAllowlist(repo), /missing non-empty reason/i);
  });
});
