import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function makeEvent(overrides) {
  return {
    invocationId: 'inv-1',
    sessionId: 'sess-1',
    threadId: 'thread-1',
    catId: 'opus',
    toolName: 'search_evidence',
    timestamp: 1000,
    turnIndex: 0,
    status: 'success',
    summary: {},
    ...overrides,
  };
}

function makeExpansionFunnel(hints, overrides = {}) {
  return {
    schemaVersion: 1,
    cohort: 'natural_topk',
    sourceRevision: 'f256-health-v2',
    eligible: true,
    gateReason: 'eligible',
    followupWindow: { maxToolDistance: 20, maxWallClockMs: 300_000 },
    attempted: true,
    keyword: { probed: hints.length, added: hints.length, deduped: 0 },
    sourceThread: { probed: 0, added: 0, deduped: 0 },
    conventionEdge: { attempted: false, added: 0, deduped: 0, staleSkipped: 0 },
    presented: hints.length,
    hints,
    ...overrides,
  };
}

describe('RecallEventCorrelator', () => {
  let RecallEventCorrelator;
  let Database;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    const mod = await import(`../../dist/domains/memory/RecallEventCorrelator.js?v=${Date.now()}`);
    RecallEventCorrelator = mod.RecallEventCorrelator;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);
  });

  it('AC-A1: correlates search_evidence → Read into consumed entry', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'F200',
          mode: 'hybrid',
          scope: 'docs',
          _f200Candidates: [
            { anchor: 'F200', rank: 1, sourcePath: 'docs/features/F200-memory-recall-eval.md', docKind: 'feature' },
            {
              anchor: 'F192',
              rank: 2,
              sourcePath: 'docs/features/F192-socio-technical-harness-eval.md',
              docKind: 'feature',
            },
          ],
        },
      }),
      makeEvent({
        toolName: 'Read',
        timestamp: 2000,
        turnIndex: 3,
        summary: { file_path: '/path/cat-cafe/docs/features/F200-memory-recall-eval.md' },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);

    assert.equal(results.length, 1);
    const re = results[0];
    assert.equal(re.toolName, 'search_evidence');
    assert.equal(re.query, 'F200');
    assert.equal(re.candidates.length, 2);
    assert.equal(re.candidates[0].anchor, 'F200');
    assert.equal(re.candidates[0].targetRef.kind, 'doc');
    assert.equal(re.consumed.length, 1);
    assert.equal(re.consumed[0].anchor, 'F200');
    assert.equal(re.consumed[0].method, 'Read');
    assert.equal(re.consumed[0].rank, 1);
    assert.equal(re.abandoned, false);
  });

  it('F256 Wave 1b: persists eligible → presented → followed → used expansion stages', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'routing memory',
          expansionFunnel: {
            schemaVersion: 1,
            cohort: 'natural_topk',
            sourceRevision: 'f256-health-v2',
            eligible: true,
            gateReason: 'eligible',
            followupWindow: { maxToolDistance: 20, maxWallClockMs: 300_000 },
            attempted: true,
            keyword: { probed: 1, added: 1, deduped: 0 },
            sourceThread: { probed: 0, added: 0, deduped: 0 },
            conventionEdge: { attempted: true, added: 1, deduped: 0, staleSkipped: 0 },
            presented: 2,
            hints: [
              {
                anchor: 'F208',
                targetRef: {
                  kind: 'doc',
                  sourcePath: 'docs/features/F208-cat-capability-profile.md',
                  anchor: 'F208',
                },
              },
              {
                anchor: 'F256',
                targetRef: {
                  kind: 'doc',
                  sourcePath: 'docs/features/F256-memory-search-strategy-evolution.md',
                  anchor: 'F256',
                },
              },
            ],
          },
        },
      }),
      makeEvent({
        toolName: 'graph_resolve',
        timestamp: 1500,
        turnIndex: 2,
        summary: { query: 'F208', selectedAnchor: 'F208', rankedCandidateAnchors: ['F208'] },
      }),
      makeEvent({
        toolName: 'command_execution',
        timestamp: 2000,
        turnIndex: 3,
        summary: { command: 'sed -n 1,20p docs/features/F256-memory-search-strategy-evolution.md' },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const search = correlator.correlateWindow(events)[0];

    assert.equal(search.expansionFunnel.eligible, true);
    assert.equal(search.expansionFunnel.presented, 2);
    assert.equal(search.expansionFunnel.followed, 2, 'direct reads count as following before they count as used');
    assert.equal(search.expansionFunnel.used, 2);

    correlator.persistBatch([search]);
    const row = db.prepare('SELECT expansion_funnel_json FROM recall_events WHERE recall_id = ?').get(search.recallId);
    assert.deepEqual(JSON.parse(row.expansion_funnel_json), search.expansionFunnel);
  });

  it('F256 P1: candidate exposure in an unrelated graph result does not count as followed', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'routing memory',
          expansionFunnel: makeExpansionFunnel([
            {
              anchor: 'F208',
              targetRef: {
                kind: 'doc',
                sourcePath: 'docs/features/F208-cat-capability-profile.md',
                anchor: 'F208',
              },
            },
          ]),
        },
      }),
      makeEvent({
        toolName: 'graph_resolve',
        timestamp: 1500,
        turnIndex: 2,
        summary: {
          query: 'unrelated-anchor',
          selectedAnchor: 'unrelated-anchor',
          rankedCandidateAnchors: ['unrelated-anchor', 'F208'],
        },
      }),
    ];

    const search = new RecallEventCorrelator(db).correlateWindow(events)[0];

    assert.equal(search.expansionFunnel.followed, 0);
    assert.equal(search.expansionFunnel.used, 0);
  });

  it('F256 P1: resolved graph anchor overrides a fuzzy query prefix for attribution', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'routing memory',
          expansionFunnel: makeExpansionFunnel([
            {
              anchor: 'F208',
              targetRef: {
                kind: 'doc',
                sourcePath: 'docs/features/F208-cat-capability-profile.md',
                anchor: 'F208',
              },
            },
          ]),
        },
      }),
      makeEvent({
        toolName: 'graph_resolve',
        timestamp: 1500,
        turnIndex: 2,
        summary: {
          query: 'F2',
          selectedAnchor: 'F2',
          rankedCandidateAnchors: ['F2', 'F208'],
        },
      }),
    ];

    const search = new RecallEventCorrelator(db).correlateWindow(events)[0];

    assert.equal(search.expansionFunnel.followed, 0);
    assert.equal(search.expansionFunnel.used, 0);
  });

  it('F256 INV-3: unresolved fuzzy graph query fails closed until an exact anchor resolves', () => {
    const searchEvent = makeEvent({
      toolName: 'search_evidence',
      timestamp: 1000,
      turnIndex: 1,
      summary: {
        query: 'routing memory',
        expansionFunnel: makeExpansionFunnel([
          {
            anchor: 'F208',
            targetRef: {
              kind: 'doc',
              sourcePath: 'docs/features/F208-cat-capability-profile.md',
              anchor: 'F208',
            },
          },
        ]),
      },
    });
    const unresolved = makeEvent({
      toolName: 'graph_resolve',
      timestamp: 1500,
      turnIndex: 2,
      summary: { query: 'F2', rankedCandidateAnchors: ['F2', 'F208'] },
    });
    const resolved = makeEvent({
      toolName: 'graph_resolve',
      timestamp: 2000,
      turnIndex: 3,
      summary: { query: 'F208', centerAnchor: 'F208', rankedCandidateAnchors: ['F208'] },
    });
    const correlator = new RecallEventCorrelator(db);

    const unresolvedSearch = correlator.correlateWindow([searchEvent, unresolved])[0];
    assert.equal(unresolvedSearch.expansionFunnel.followed, 0);
    assert.equal(unresolvedSearch.expansionFunnel.used, 0);

    const resolvedSearch = correlator.correlateWindow([searchEvent, unresolved, resolved])[0];
    assert.equal(resolvedSearch.expansionFunnel.followed, 1);
    assert.equal(resolvedSearch.expansionFunnel.used, 1);
  });

  it('F256 P1: typed source-thread hint attributes get_thread_context consumption', () => {
    const hints = [
      {
        anchor: 'thread-thread_abc',
        targetRef: { kind: 'thread', threadId: 'thread_abc' },
      },
    ];
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'related discussion',
          expansionFunnel: makeExpansionFunnel(hints, {
            keyword: { probed: 0, added: 0, deduped: 0 },
            sourceThread: { probed: 1, added: 1, deduped: 0 },
          }),
        },
      }),
      makeEvent({
        toolName: 'get_thread_context',
        timestamp: 1500,
        turnIndex: 2,
        summary: { threadId: 'thread_abc' },
      }),
    ];

    const search = new RecallEventCorrelator(db).correlateWindow(events)[0];

    assert.equal(search.expansionFunnel.followed, 1);
    assert.equal(search.expansionFunnel.used, 1);
  });

  it('F256 INV-3: expansion file reads require an exact normalized sourcePath', () => {
    const searchEvent = makeEvent({
      toolName: 'search_evidence',
      timestamp: 1000,
      turnIndex: 1,
      summary: {
        query: 'contract',
        expansionFunnel: makeExpansionFunnel([
          {
            anchor: 'F2',
            targetRef: {
              kind: 'doc',
              sourcePath: 'docs/features/F2-contract.md',
              anchor: 'F2',
            },
          },
        ]),
      },
    });
    const cases = [
      {
        method: 'Read',
        falsePositiveInput: { file_path: '/repo/docs/features/F208-capability.md' },
        exactInput: { file_path: '/repo/docs/features/F2-contract.md' },
      },
      {
        method: 'Grep',
        falsePositiveInput: { pattern: 'contract', path: '/repo/docs/features/F208-capability.md' },
        exactInput: { pattern: 'contract', path: '/repo/docs/features/F2-contract.md' },
      },
      {
        method: 'command_execution',
        falsePositiveInput: { command: "sed -n '1,20p' /repo/docs/features/F208-capability.md" },
        exactInput: { command: "sed -n '1,20p' /repo/docs/features/F2-contract.md" },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const falsePositive = makeEvent({
        toolName: testCase.method,
        timestamp: 1500,
        turnIndex: 2,
        summary: testCase.falsePositiveInput,
      });
      const wrongTarget = new RecallEventCorrelator(db).correlateWindow([searchEvent, falsePositive])[0];
      assert.equal(wrongTarget.expansionFunnel.followed, 0, `${testCase.method} F2 must not match F208`);
      assert.equal(wrongTarget.expansionFunnel.used, 0, `${testCase.method} F2 must not use F208`);

      const exact = makeEvent({
        toolName: testCase.method,
        timestamp: 2000 + index,
        turnIndex: 3,
        summary: testCase.exactInput,
      });
      const exactTarget = new RecallEventCorrelator(db).correlateWindow([searchEvent, exact])[0];
      assert.equal(exactTarget.expansionFunnel.followed, 1, `${testCase.method} exact path follows`);
      assert.equal(exactTarget.expansionFunnel.used, 1, `${testCase.method} exact path uses`);
    }
  });

  it('F256 INV-3: expansion file reads fail closed when sourcePath is absent', () => {
    const searchEvent = makeEvent({
      toolName: 'search_evidence',
      timestamp: 1000,
      turnIndex: 1,
      summary: {
        query: 'contract',
        expansionFunnel: makeExpansionFunnel([
          {
            anchor: 'F2',
            targetRef: { kind: 'doc', sourcePath: '', anchor: 'F2' },
          },
        ]),
      },
    });
    const cases = [
      { method: 'Read', summary: { file_path: '/repo/docs/features/F2-contract.md' } },
      { method: 'Grep', summary: { pattern: 'contract', path: '/repo/docs/features/F2-contract.md' } },
      {
        method: 'command_execution',
        summary: { command: "sed -n '1,20p' /repo/docs/features/F2-contract.md" },
      },
    ];

    for (const testCase of cases) {
      const readEvent = makeEvent({
        toolName: testCase.method,
        timestamp: 1500,
        turnIndex: 2,
        summary: testCase.summary,
      });
      const search = new RecallEventCorrelator(db).correlateWindow([searchEvent, readEvent])[0];
      assert.equal(search.expansionFunnel.followed, 0, `${testCase.method} must fail closed`);
      assert.equal(search.expansionFunnel.used, 0, `${testCase.method} must fail closed`);
    }
  });

  it('HW-4 根因③: same-invocation searches before first downstream read share resultSetId', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'A', _f200Candidates: [{ anchor: 'F1', rank: 1, sourcePath: 'docs/f1.md' }] },
      }),
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1100,
        turnIndex: 2,
        summary: { query: 'B', _f200Candidates: [{ anchor: 'F2', rank: 1, sourcePath: 'docs/f2.md' }] },
      }),
      makeEvent({ toolName: 'Read', timestamp: 2000, turnIndex: 3, summary: { file_path: 'docs/f1.md' } }),
    ];
    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results.length, 2);
    assert.ok(results[0].resultSetId, 'resultSetId assigned');
    assert.equal(results[0].resultSetId, results[1].resultSetId, 'searches before first read = one bundle');
  });

  it('HW-4 根因③: shell-read between searches splits the bundle (P2 交错, 砚砚)', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'A', _f200Candidates: [{ anchor: 'F1', rank: 1, sourcePath: 'docs/f1.md' }] },
      }),
      makeEvent({
        toolName: 'command_execution',
        timestamp: 1100,
        turnIndex: 2,
        summary: { command: `/bin/zsh -lc "sed -n 1,5p docs/f1.md"` },
      }),
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1200,
        turnIndex: 3,
        summary: { query: 'B', _f200Candidates: [{ anchor: 'F2', rank: 1, sourcePath: 'docs/f2.md' }] },
      }),
      makeEvent({
        toolName: 'command_execution',
        timestamp: 1300,
        turnIndex: 4,
        summary: { command: `/bin/zsh -lc "sed -n 1,5p docs/f2.md"` },
      }),
    ];
    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results.length, 2);
    assert.notEqual(
      results[0].resultSetId,
      results[1].resultSetId,
      'shell-read between A and B splits bundle — not mixed into one (砚砚 P2)',
    );
  });

  it('HW-4 根因③: overlapping candidate pool consumed → ambiguous, unique → clean', () => {
    // Bundle with two searches whose candidate pools BOTH contain F1; one
    // later read of F1 can credit either search → ambiguous.
    const ambiguous = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'A', _f200Candidates: [{ anchor: 'F1', rank: 1, sourcePath: 'docs/f1.md' }] },
      }),
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1100,
        turnIndex: 2,
        summary: { query: 'B', _f200Candidates: [{ anchor: 'F1', rank: 1, sourcePath: 'docs/f1.md' }] },
      }),
      makeEvent({ toolName: 'Read', timestamp: 2000, turnIndex: 3, summary: { file_path: 'docs/f1.md' } }),
    ];
    const r1 = new RecallEventCorrelator(db).correlateWindow(ambiguous);
    const consumed1 = r1.filter((r) => r.consumed.length > 0);
    assert.ok(consumed1.length > 0, 'at least one consumed');
    assert.ok(
      consumed1.some((r) => r.attributionClarity === 'ambiguous'),
      'overlapping candidate pool → ambiguous',
    );

    // Single search, unique match → clean
    const clean = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'solo', _f200Candidates: [{ anchor: 'F9', rank: 1, sourcePath: 'docs/f9.md' }] },
      }),
      makeEvent({ toolName: 'Read', timestamp: 2000, turnIndex: 2, summary: { file_path: 'docs/f9.md' } }),
    ];
    const r2 = new RecallEventCorrelator(db).correlateWindow(clean);
    assert.equal(r2[0].consumed.length, 1);
    assert.equal(r2[0].attributionClarity, 'clean', 'single-search unique match → clean');
  });

  it('HW-4 gpt52 review: command_execution multi-file shell-read credits ALL paths', () => {
    // gpt52 本地复现：一条 command_execution 读多文件（sed a; sed b），
    // findConsumed inner `break` 限制 → 第二个 file false negative。
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'multi',
          _f200Candidates: [
            { anchor: 'A', rank: 1, sourcePath: 'docs/a.md', docKind: 'feature' },
            { anchor: 'B', rank: 2, sourcePath: 'docs/b.md', docKind: 'feature' },
          ],
        },
      }),
      makeEvent({
        toolName: 'command_execution',
        timestamp: 2000,
        turnIndex: 3,
        summary: { command: `/bin/zsh -lc "sed -n 1,5p docs/a.md; sed -n 1,5p docs/b.md"` },
      }),
    ];
    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results.length, 1);
    const anchors = new Set(results[0].consumed.map((c) => c.anchor));
    assert.ok(anchors.has('A'), 'multi-file shell-read must credit A');
    assert.ok(anchors.has('B'), 'multi-file shell-read must credit B (gpt52 P1: inner break drops second)');
    assert.equal(results[0].consumed.length, 2);
  });

  it('HW-4 gpt52 review R2: no-break narrowed to command_execution — graph_resolve not amplified', () => {
    // gpt52 R2 P1: 上轮去 break 修 multi-file 的同时，把 graph_resolve 旧 break
    // 单个子串误命中（pre-existing matcher bug）放大成多个误命中
    // graph_resolve(query="F10") candidate [F1, F10]：旧 break consumed=["F1"]，
    // 去 break consumed=["F1","F10"] ← 我引入的 regression。
    // 修复：no-break 限 command_execution，其他 method 保留 break。
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'F',
          _f200Candidates: [
            { anchor: 'F1', rank: 1, sourcePath: 'docs/f1.md', docKind: 'feature' },
            { anchor: 'F10', rank: 2, sourcePath: 'docs/f10.md', docKind: 'feature' },
          ],
        },
      }),
      makeEvent({
        toolName: 'graph_resolve',
        timestamp: 2000,
        turnIndex: 3,
        summary: { query: 'F10' },
      }),
    ];
    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    const search = results.find((r) => r.toolName === 'search_evidence');
    assert.ok(search);
    assert.ok(
      search.consumed.length <= 1,
      `graph_resolve must not amplify to multi-match (gpt52 R2 P1); got ${JSON.stringify(search.consumed.map((c) => c.anchor))}`,
    );
  });

  it('HW-4 云端 codex round4 P1-b: graph_resolve closes bundle as consuming event', () => {
    // graph_resolve 是 CONSUMING_METHOD 也是 MEMORY_TOOLS（双重身份）→ correlateWindow
    // 现"if MEMORY_TOOLS else if isConsumingEvent" 只走前者，不关闭前 bundle。
    // 序列 search→graph_resolve→search 错并一 bundle → 候选池重叠 → ambiguous 膨胀。
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'q1', _f200Candidates: [{ anchor: 'X', rank: 1, sourcePath: 'docs/x.md' }] },
      }),
      makeEvent({
        toolName: 'graph_resolve',
        timestamp: 1100,
        turnIndex: 2,
        summary: { query: 'X', _f200Candidates: [{ anchor: 'Y', rank: 1, sourcePath: 'docs/y.md' }] },
      }),
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1200,
        turnIndex: 3,
        summary: { query: 'q2', _f200Candidates: [{ anchor: 'Z', rank: 1, sourcePath: 'docs/z.md' }] },
      }),
    ];
    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results.length, 3, '3 MEMORY_TOOLS events → 3 recall events');
    const ids = results.map((r) => r.resultSetId);
    assert.notEqual(ids[0], ids[1], 'graph_resolve as consuming event closes search1 bundle');
    assert.notEqual(ids[1], ids[2], 'graph_resolve opens own bundle separate from search2');
    assert.notEqual(ids[0], ids[2], 'all 3 isolated');
  });

  it('HW-4 根因②a: command_execution shell-read counts as consumption', () => {
    // audit Round 1: Codex reads docs via `/bin/zsh -lc "sed -n ... FILE"`
    // command_execution events — currently NOT in CONSUMED_METHODS, so a
    // genuinely-used candidate is scored as abandoned (false negative).
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'F200',
          _f200Candidates: [
            { anchor: 'F200', rank: 1, sourcePath: 'docs/features/F200-memory-recall-eval.md', docKind: 'feature' },
          ],
        },
      }),
      makeEvent({
        toolName: 'command_execution',
        timestamp: 2000,
        turnIndex: 3,
        summary: { command: `/bin/zsh -lc "sed -n '1,260p' docs/features/F200-memory-recall-eval.md"` },
      }),
    ];
    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results.length, 1);
    assert.equal(results[0].consumed.length, 1, 'shell-read via command_execution must count as consumption');
    assert.equal(results[0].consumed[0].anchor, 'F200');
    assert.equal(results[0].consumed[0].method, 'command_execution');
    assert.equal(results[0].abandoned, false);
  });

  it('AC-A2: excluded when BOTH distance > 20 AND wall-clock > 300s', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'test',
          _f200Candidates: [{ anchor: 'A', rank: 1, sourcePath: 'docs/a.md', docKind: 'feature' }],
        },
      }),
    ];
    // Add 25 unrelated events spanning > 300s
    for (let i = 2; i <= 26; i++) {
      events.push(makeEvent({ toolName: 'SomeOtherTool', timestamp: 1000 + i * 15_000, turnIndex: i }));
    }
    // Read at distance 26 (> 20) AND timestamp > 300s
    events.push(
      makeEvent({
        toolName: 'Read',
        timestamp: 1000 + 400_000,
        turnIndex: 27,
        summary: { file_path: '/path/docs/a.md' },
      }),
    );

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].consumed.length, 0, 'not consumed: both bounds exceeded');
    assert.equal(results[0].abandoned, true);
  });

  it('AC-A2: included when distance > 20 but wall-clock <= 300s (OR logic)', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'test',
          _f200Candidates: [{ anchor: 'A', rank: 1, sourcePath: 'docs/a.md', docKind: 'feature' }],
        },
      }),
    ];
    // 25 rapid events (distance > 20 but all within 300s)
    for (let i = 2; i <= 26; i++) {
      events.push(makeEvent({ toolName: 'SomeOtherTool', timestamp: 1000 + i * 100, turnIndex: i }));
    }
    events.push(
      makeEvent({
        toolName: 'Read',
        timestamp: 4000,
        turnIndex: 27,
        summary: { file_path: '/path/docs/a.md' },
      }),
    );

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].consumed.length, 1, 'OR: distance>20 but wall_clock<300s → included');
  });

  it('AC-A2: included when wall-clock > 300s but distance <= 20 (OR logic)', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'test',
          _f200Candidates: [{ anchor: 'A', rank: 1, sourcePath: 'docs/a.md', docKind: 'feature' }],
        },
      }),
      makeEvent({
        toolName: 'Read',
        timestamp: 1000 + 400_000,
        turnIndex: 3,
        summary: { file_path: '/path/docs/a.md' },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].consumed.length, 1, 'OR: wall_clock>300s but distance<=20 → included');
  });

  it('AC-A2: respects invocation boundary', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        invocationId: 'inv-A',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'test',
          _f200Candidates: [{ anchor: 'A', rank: 1, sourcePath: 'docs/a.md', docKind: 'feature' }],
        },
      }),
      makeEvent({
        toolName: 'Read',
        invocationId: 'inv-B', // different invocation
        timestamp: 2000,
        turnIndex: 3,
        summary: { file_path: '/path/docs/a.md' },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].consumed.length, 0, 'not consumed: different invocation');
  });

  it('AC-A3: marks reformulated on consecutive search calls', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'first query', _f200Candidates: [] },
      }),
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 2000,
        turnIndex: 3,
        summary: { query: 'second query', _f200Candidates: [] },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].reformulated, true, 'first search is reformulated');
  });

  it('AC-A3: marks fellBackToGrep', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'test', _f200Candidates: [] },
      }),
      makeEvent({
        toolName: 'Bash',
        timestamp: 2000,
        turnIndex: 3,
        summary: { command: 'rg "pattern" docs/' },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].fellBackToGrep, true);
  });

  it('AC-A3: marks abandoned', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: { query: 'test', _f200Candidates: [] },
      }),
      makeEvent({ toolName: 'SomeOtherTool', timestamp: 2000, turnIndex: 3 }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].abandoned, true);
  });

  it('AC-A3: marks nextGraphResolveAfterRead', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'test',
          _f200Candidates: [{ anchor: 'A', rank: 1, sourcePath: 'docs/a.md', docKind: 'feature' }],
        },
      }),
      makeEvent({
        toolName: 'Read',
        timestamp: 2000,
        turnIndex: 3,
        summary: { file_path: '/path/docs/a.md' },
      }),
      makeEvent({
        toolName: 'graph_resolve',
        timestamp: 3000,
        turnIndex: 5,
        summary: { query: 'A' },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].nextGraphResolveAfterRead, true);
  });

  it('AC-A5: records dwellProxy', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'test',
          _f200Candidates: [{ anchor: 'A', rank: 1, sourcePath: 'docs/a.md', docKind: 'feature' }],
        },
      }),
      makeEvent({
        toolName: 'Read',
        timestamp: 5000,
        turnIndex: 3,
        summary: { file_path: '/path/docs/a.md' },
      }),
      makeEvent({
        toolName: 'Edit',
        timestamp: 8000,
        turnIndex: 5,
        summary: {},
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].consumed[0].dwellProxy, 3000, 'dwellProxy = next tool timestamp - Read timestamp');
  });

  it('persistBatch writes to recall_events table', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'persist test',
          _f200Candidates: [{ anchor: 'B', rank: 1, sourcePath: 'docs/b.md', docKind: 'feature' }],
        },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    correlator.persistBatch(results);

    const row = db.prepare('SELECT * FROM recall_events WHERE cat_id = ?').get('opus');
    assert.ok(row, 'row exists');
    assert.equal(row.tool_name, 'search_evidence');
    assert.equal(row.query, 'persist test');
    assert.equal(row.abandoned, 1);

    const candidates = JSON.parse(row.candidates_json);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].anchor, 'B');
  });

  it('persistBatch preserves reported hit count when candidates are empty', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'thread search without anchors',
          resultCount: 8,
          resultStatus: 'counted',
        },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].resultCount, 8);
    assert.equal(results[0].resultStatus, 'counted');
    assert.deepEqual(results[0].candidates, []);

    correlator.persistBatch(results);

    const row = db
      .prepare('SELECT result_count, result_status, candidates_json FROM recall_events WHERE query = ?')
      .get('thread search without anchors');
    assert.ok(row, 'row exists');
    assert.equal(row.result_count, 8);
    assert.equal(row.result_status, 'counted');
    assert.deepEqual(JSON.parse(row.candidates_json), []);
  });

  it('distinguishes unmerged tool results from parser misses', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'tool result never arrived',
        },
      }),
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 2000,
        turnIndex: 2,
        summary: {
          query: 'tool result parser missed',
          _resultMerged: true,
        },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);

    assert.equal(results[0].resultStatus, 'result_unmerged');
    assert.equal(results[1].resultStatus, 'parser_miss');

    correlator.persistBatch(results);

    const rows = db
      .prepare('SELECT query, result_status FROM recall_events ORDER BY timestamp ASC')
      .all()
      .map((row) => [row.query, row.result_status]);
    assert.deepEqual(rows, [
      ['tool result never arrived', 'result_unmerged'],
      ['tool result parser missed', 'parser_miss'],
    ]);
  });

  it('infers status from legacy merged resultCount before parser_miss fallback', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'legacy counted result',
          resultCount: 3,
          _resultMerged: true,
        },
      }),
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 2000,
        turnIndex: 2,
        summary: {
          query: 'legacy empty result',
          resultCount: 0,
          _resultMerged: true,
        },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);

    assert.equal(results[0].resultStatus, 'counted');
    assert.equal(results[0].resultCount, 3);
    assert.equal(results[1].resultStatus, 'no_results');
    assert.equal(results[1].resultCount, 0);

    correlator.persistBatch(results);

    const rows = db
      .prepare('SELECT query, result_count, result_status FROM recall_events ORDER BY timestamp ASC')
      .all()
      .map((row) => [row.query, row.result_count, row.result_status]);
    assert.deepEqual(rows, [
      ['legacy counted result', 3, 'counted'],
      ['legacy empty result', 0, 'no_results'],
    ]);
  });

  it('multiple consumed entries from different candidates', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'multi',
          _f200Candidates: [
            { anchor: 'X', rank: 1, sourcePath: 'docs/x.md', docKind: 'feature' },
            { anchor: 'Y', rank: 2, sourcePath: 'docs/y.md', docKind: 'decision' },
          ],
        },
      }),
      makeEvent({
        toolName: 'Read',
        timestamp: 2000,
        turnIndex: 3,
        summary: { file_path: '/path/docs/x.md' },
      }),
      makeEvent({
        toolName: 'Read',
        timestamp: 3000,
        turnIndex: 5,
        summary: { file_path: '/path/docs/y.md' },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    assert.equal(results[0].consumed.length, 2);
    assert.equal(results[0].consumed[0].anchor, 'X');
    assert.equal(results[0].consumed[1].anchor, 'Y');
  });

  it('F102 bugfix: persistBatch writes thread_id for RecallFeed history', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        threadId: 'thread-abc-123',
        timestamp: 1000,
        turnIndex: 1,
        summary: {
          query: 'thread persist test',
          _f200Candidates: [{ anchor: 'T', rank: 1, sourcePath: 'docs/t.md', docKind: 'feature' }],
        },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    // Simulate what recall-correlation-hook does: attach threadId before persist
    for (const re of results) {
      re.threadId = events[0].threadId;
    }
    correlator.persistBatch(results);

    const row = db.prepare('SELECT * FROM recall_events WHERE cat_id = ?').get('opus');
    assert.ok(row, 'row exists');
    assert.equal(row.thread_id, 'thread-abc-123', 'thread_id persisted for RecallFeed history');
    assert.equal(row.query, 'thread persist test');
  });

  it('F102 bugfix: thread_id defaults to empty string when not provided', () => {
    const events = [
      makeEvent({
        toolName: 'search_evidence',
        threadId: '', // no thread context
        timestamp: 5000,
        turnIndex: 1,
        summary: {
          query: 'no thread test',
          _f200Candidates: [{ anchor: 'N', rank: 1, sourcePath: 'docs/n.md', docKind: 'feature' }],
        },
      }),
    ];

    const correlator = new RecallEventCorrelator(db);
    const results = correlator.correlateWindow(events);
    correlator.persistBatch(results);

    const row = db.prepare("SELECT * FROM recall_events WHERE query = 'no thread test'").get();
    assert.ok(row, 'row exists');
    assert.equal(row.thread_id, '', 'thread_id defaults to empty string');
  });
});
