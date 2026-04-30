import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('backlog-doc-import parser', () => {
  test('accepts markdown rows without trailing pipe', async () => {
    const { parseActiveFeaturesFromBacklog } = await import('../dist/routes/backlog-doc-import.js');
    const markdown = [
      '| ID | 名称 | Status | Owner | Link |',
      '|----|------|--------|-------|------|',
      '| F010 | A | in-progress | 三猫 | [F010](a)',
    ].join('\n');

    const rows = parseActiveFeaturesFromBacklog(markdown);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'F010');
  });

  test('skips blank lines inside table body', async () => {
    const { parseActiveFeaturesFromBacklog } = await import('../dist/routes/backlog-doc-import.js');
    const markdown = [
      '| ID | 名称 | Status | Owner | Link |',
      '|----|------|--------|-------|------|',
      '| F010 | A | in-progress | 三猫 | [F010](a) |',
      '',
      '| F011 | B | spec | 三猫 | [F011](b) |',
    ].join('\n');

    const rows = parseActiveFeaturesFromBacklog(markdown);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'F010');
    assert.equal(rows[1].id, 'F011');
  });

  test('parses table with extra Source column (6 columns)', async () => {
    const { parseActiveFeaturesFromBacklog } = await import('../dist/routes/backlog-doc-import.js');
    const markdown = [
      '| ID | 名称 | Status | Owner | Source | Link |',
      '|----|------|--------|-------|--------|------|',
      '| F010 | 手机端猫猫 | in-progress | 三猫 | internal | [F010](features/F010.md) |',
      '| F044 | Channel System | spec | 布偶猫 | community | [F044](features/F044.md) |',
    ].join('\n');

    const rows = parseActiveFeaturesFromBacklog(markdown);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'F010');
    assert.equal(rows[0].name, '手机端猫猫');
    assert.equal(rows[0].status, 'in-progress');
    assert.equal(rows[0].owner, '三猫');
    assert.equal(rows[0].link, 'features/F010.md');
    assert.equal(rows[1].id, 'F044');
    assert.equal(rows[1].status, 'spec');
    assert.equal(rows[1].owner, '布偶猫');
    assert.equal(rows[1].link, 'features/F044.md');
  });

  test('parses table with reordered columns', async () => {
    const { parseActiveFeaturesFromBacklog } = await import('../dist/routes/backlog-doc-import.js');
    const markdown = [
      '| ID | Status | 名称 | Owner | Link |',
      '|----|--------|------|-------|------|',
      '| F010 | in-progress | 手机端猫猫 | 三猫 | [F010](a.md) |',
    ].join('\n');

    const rows = parseActiveFeaturesFromBacklog(markdown);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '手机端猫猫');
    assert.equal(rows[0].status, 'in-progress');
  });

  test('throws when required columns are missing from header', async () => {
    const { parseActiveFeaturesFromBacklog } = await import('../dist/routes/backlog-doc-import.js');
    const markdown = [
      '| ID | Name | Status | Owner | Link |',
      '|----|------|--------|-------|------|',
      '| F010 | A | in-progress | 三猫 | [F010](a) |',
    ].join('\n');

    assert.throws(() => parseActiveFeaturesFromBacklog(markdown), {
      message: /missing required columns/i,
    });
  });

  test('throws when no table header found at all', async () => {
    const { parseActiveFeaturesFromBacklog } = await import('../dist/routes/backlog-doc-import.js');
    assert.throws(() => parseActiveFeaturesFromBacklog('# Just a heading\n\nNo table here'), {
      message: /missing required columns/i,
    });
  });

  test('accepts header rows without trailing pipe', async () => {
    const { parseActiveFeaturesFromBacklog } = await import('../dist/routes/backlog-doc-import.js');
    const markdown = [
      '| ID | 名称 | Status | Owner | Link',
      '|----|------|--------|-------|------|',
      '| F010 | A | in-progress | 三猫 | [F010](a)',
    ].join('\n');

    const rows = parseActiveFeaturesFromBacklog(markdown);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'F010');
  });
});

describe('parseFeatureDocStatus', () => {
  test('returns done for Status: done in markdown', async () => {
    const { parseFeatureDocStatus } = await import('../dist/routes/backlog-doc-import.js');
    const md = '> **Status**: done\n> **Owner**: 布偶猫';
    assert.strictEqual(parseFeatureDocStatus(md), 'done');
  });

  test('returns spec for Status: spec', async () => {
    const { parseFeatureDocStatus } = await import('../dist/routes/backlog-doc-import.js');
    const md = '> **Status**: spec\n';
    assert.strictEqual(parseFeatureDocStatus(md), 'spec');
  });

  test('returns null for no Status line', async () => {
    const { parseFeatureDocStatus } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(parseFeatureDocStatus('# Title\n\nNo status here'), null);
  });

  test('returns done from YAML frontmatter status field', async () => {
    const { parseFeatureDocStatus } = await import('../dist/routes/backlog-doc-import.js');
    const md = ['---', 'feature_ids: [F068]', 'status: done', '---', '', '# F068 — New Thread Dialog UX'].join('\n');
    assert.strictEqual(parseFeatureDocStatus(md), 'done');
  });

  test('prefers body status over frontmatter when both exist', async () => {
    const { parseFeatureDocStatus } = await import('../dist/routes/backlog-doc-import.js');
    const md = ['---', 'status: spec', '---', '', '> **Status**: in-progress'].join('\n');
    assert.strictEqual(parseFeatureDocStatus(md), 'in-progress');
  });

  test('returns frontmatter status when body has no Status line', async () => {
    const { parseFeatureDocStatus } = await import('../dist/routes/backlog-doc-import.js');
    const md = ['---', 'status: in-progress', '---', '', '# F064 — A2A Exit Check', '', '> **Owner**: 布偶猫'].join(
      '\n',
    );
    assert.strictEqual(parseFeatureDocStatus(md), 'in-progress');
  });
});

describe('parseFeatureDocDependencies', () => {
  test('extracts evolvedFrom and related from frontmatter + body', async () => {
    const { parseFeatureDocDependencies } = await import('../dist/routes/backlog-doc-import.js');
    const md = [
      '---',
      'feature_ids: [F058]',
      'related_features: [F049, F037]',
      '---',
      '',
      '## Dependencies',
      '',
      '- **Evolved from**: F049（Mission Control MVP）',
      '- **Related**: F037（Agent Swarm）',
    ].join('\n');
    const deps = parseFeatureDocDependencies(md);
    assert.deepStrictEqual(deps.evolvedFrom, ['f049']);
    assert.deepStrictEqual(deps.related, ['f037']);
  });

  test('extracts blockedBy', async () => {
    const { parseFeatureDocDependencies } = await import('../dist/routes/backlog-doc-import.js');
    const md = ['---', 'feature_ids: [F099]', '---', '', '- **Blocked by**: F052'].join('\n');
    const deps = parseFeatureDocDependencies(md);
    assert.deepStrictEqual(deps.blockedBy, ['f052']);
  });

  test('returns empty object for no dependencies', async () => {
    const { parseFeatureDocDependencies } = await import('../dist/routes/backlog-doc-import.js');
    const md = '# Title\n\nNo deps here';
    const deps = parseFeatureDocDependencies(md);
    assert.deepStrictEqual(deps, {});
  });

  test('extracts Related from body text (not just frontmatter)', async () => {
    const { parseFeatureDocDependencies } = await import('../dist/routes/backlog-doc-import.js');
    const md = [
      '---',
      'feature_ids: [F055]',
      '---',
      '',
      '- **Evolved from**: F050',
      '- **Related**: F046（Anti-Drift Protocol）',
      '- **Related**: F042（Prompt Engineering Audit）',
    ].join('\n');
    const deps = parseFeatureDocDependencies(md);
    assert.deepStrictEqual(deps.evolvedFrom, ['f050']);
    assert.deepStrictEqual(deps.related?.sort(), ['f042', 'f046']);
  });

  test('rejects non-F\\d{3} frontmatter related_features (e.g. F32-b)', async () => {
    const { parseFeatureDocDependencies } = await import('../dist/routes/backlog-doc-import.js');
    const md = ['---', 'related_features: [F032, F32-b, F049]', '---', '', '# Test'].join('\n');
    const deps = parseFeatureDocDependencies(md);
    // F32-b should be rejected, only F032 and F049 accepted
    assert.deepStrictEqual(deps.related?.sort(), ['f032', 'f049']);
  });

  test('filters placeholder Related lines (无/TBD)', async () => {
    const { parseFeatureDocDependencies } = await import('../dist/routes/backlog-doc-import.js');
    const md = ['---', 'feature_ids: [F094]', '---', '', '- **Related**: 无', '- **Blocked by**: 待定'].join('\n');
    const deps = parseFeatureDocDependencies(md);
    assert.deepStrictEqual(deps, {});
  });
});

describe('featureStatusToBacklogStatus', () => {
  test('maps in-progress to dispatched', async () => {
    const { featureStatusToBacklogStatus } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(featureStatusToBacklogStatus('in-progress'), 'dispatched');
  });

  test('maps in-review to dispatched', async () => {
    const { featureStatusToBacklogStatus } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(featureStatusToBacklogStatus('in-review'), 'dispatched');
  });

  test('maps done to done', async () => {
    const { featureStatusToBacklogStatus } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(featureStatusToBacklogStatus('done'), 'done');
  });

  test('maps spec to open', async () => {
    const { featureStatusToBacklogStatus } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(featureStatusToBacklogStatus('spec'), 'open');
  });

  test('maps idea to open', async () => {
    const { featureStatusToBacklogStatus } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(featureStatusToBacklogStatus('idea'), 'open');
  });

  test('maps done (Phase 1) to dispatched', async () => {
    const { featureStatusToBacklogStatus } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(featureStatusToBacklogStatus('done (Phase 1)'), 'dispatched');
  });
});

describe('buildBacklogInputFromFeature initialStatus', () => {
  test('in-progress feature gets initialStatus dispatched', async () => {
    const { buildBacklogInputFromFeature } = await import('../dist/routes/backlog-doc-import.js');
    const row = {
      id: 'F064',
      name: 'A2A Exit Check',
      status: 'in-progress',
      owner: '布偶猫',
      link: 'features/F064.md',
    };
    const input = buildBacklogInputFromFeature(row, 'user1');
    assert.strictEqual(input.initialStatus, 'dispatched');
  });

  test('spec feature gets no initialStatus (defaults to open)', async () => {
    const { buildBacklogInputFromFeature } = await import('../dist/routes/backlog-doc-import.js');
    const row = { id: 'F055', name: 'Routing', status: 'spec', owner: '布偶猫' };
    const input = buildBacklogInputFromFeature(row, 'user1');
    assert.strictEqual(input.initialStatus, undefined);
  });

  test('in-review feature gets initialStatus dispatched', async () => {
    const { buildBacklogInputFromFeature } = await import('../dist/routes/backlog-doc-import.js');
    const row = { id: 'F063', name: 'Hub Explorer', status: 'in-review', owner: '布偶猫' };
    const input = buildBacklogInputFromFeature(row, 'user1');
    assert.strictEqual(input.initialStatus, 'dispatched');
  });
});

describe('parseFeatureDocName', () => {
  test('extracts name from heading like # F049: Mission Hub — Backlog Center', async () => {
    const { parseFeatureDocName } = await import('../dist/routes/backlog-doc-import.js');
    const md = '# F049: Mission Hub — Backlog Center\n\n> **Status**: done';
    assert.strictEqual(parseFeatureDocName(md), 'Mission Hub — Backlog Center');
  });

  test('returns null for no heading', async () => {
    const { parseFeatureDocName } = await import('../dist/routes/backlog-doc-import.js');
    assert.strictEqual(parseFeatureDocName('No heading here'), null);
  });

  test('extracts from heading with extra whitespace', async () => {
    const { parseFeatureDocName } = await import('../dist/routes/backlog-doc-import.js');
    const md = '#  F058:  Mission Control 增强  \n';
    assert.strictEqual(parseFeatureDocName(md), 'Mission Control 增强');
  });
});

describe('gitShowFile', () => {
  test('reads a file from origin/main', async () => {
    const { _resetFetchTimer, gitShowFile } = await import('../dist/routes/git-doc-reader.js');
    const repoDir = mkdtempSync(join(tmpdir(), 'git-doc-reader-read-'));
    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    writeFileSync(join(repoDir, 'docs', 'ROADMAP.md'), '| ID | backlog |\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: repoDir });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repoDir });
    _resetFetchTimer();
    try {
      const content = await gitShowFile('docs/ROADMAP.md', repoDir);
      assert.ok(content, 'should return content');
      assert.ok(content.includes('| ID |') || content.includes('backlog'), 'should contain expected content');
    } finally {
      _resetFetchTimer();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('uses cached origin/main ref when fetch fails transiently', async () => {
    const { _resetFetchTimer, gitListFeatureDocs, gitShowFile } = await import('../dist/routes/git-doc-reader.js');
    const repoDir = mkdtempSync(join(tmpdir(), 'git-doc-reader-repo-'));
    mkdirSync(join(repoDir, 'docs', 'features'), { recursive: true });
    writeFileSync(join(repoDir, 'docs', 'ROADMAP.md'), 'cached backlog content\n');
    writeFileSync(join(repoDir, 'docs', 'features', 'F001-test.md'), '# F001 — Test\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: repoDir });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repoDir });
    _resetFetchTimer();
    try {
      const content = await gitShowFile('docs/ROADMAP.md', repoDir);
      assert.strictEqual(content, 'cached backlog content\n');
      const entries = await gitListFeatureDocs('docs/features', repoDir);
      assert.deepStrictEqual(entries, ['F001-test.md']);
    } finally {
      _resetFetchTimer();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('returns null for non-existent path', async () => {
    const { gitShowFile } = await import('../dist/routes/git-doc-reader.js');
    const content = await gitShowFile('docs/DOES_NOT_EXIST_12345.md');
    assert.strictEqual(content, null);
  });
});

describe('fetch throttle (storm prevention)', () => {
  test('failed fetch also throttles — no repeated attempts within window', async () => {
    const { _resetFetchTimer, gitShowFile } = await import('../dist/routes/git-doc-reader.js');
    _resetFetchTimer();
    // First call triggers a real fetch (succeeds in CI/local)
    await gitShowFile('docs/ROADMAP.md');
    // Measure time for a second call — should be throttled (no new fetch)
    const start = Date.now();
    await gitShowFile('docs/ROADMAP.md');
    const elapsed = Date.now() - start;
    // Throttled call should be fast (<500ms), not a 10s timeout
    assert.ok(elapsed < 500, `second call should be throttled but took ${elapsed}ms`);
    _resetFetchTimer();
  });
});

describe('gitListFeatureDocs', () => {
  test('lists feature doc filenames from origin/main', async () => {
    const { gitListFeatureDocs } = await import('../dist/routes/git-doc-reader.js');
    const entries = await gitListFeatureDocs();
    assert.ok(Array.isArray(entries), 'should return an array');
    assert.ok(entries.length > 0, 'should find feature docs');
    assert.ok(
      entries.some((e) => e.startsWith('F0')),
      'should contain F0xx entries',
    );
  });

  test('returns empty array on git failure', async () => {
    const { gitListFeatureDocs } = await import('../dist/routes/git-doc-reader.js');
    // Bad dir should fallback gracefully
    const entries = await gitListFeatureDocs('nonexistent/path');
    assert.ok(Array.isArray(entries));
  });
});
