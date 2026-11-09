import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { getCoCreatorConfig } = await import('../dist/config/cat-config-loader.js');
const coCreator = getCoCreatorConfig();
const userLabel = coCreator.nickname ?? coCreator.name;

const { summarizeActiveTasks, formatNavigationHeader } = await import(
  '../dist/domains/cats/services/agents/routing/navigation-context.js'
);

it('shows known absent waits only for the current owner, without treating unknown as absent', () => {
  const text = formatNavigationHeader({
    currentCatId: 'codex',
    tasks: [
      { id: '1', title: '自己的待办', status: 'doing', ownerCatId: 'codex', hasActiveWait: false },
      { id: '2', title: '别猫的待办', status: 'todo', ownerCatId: 'opus', hasActiveWait: false },
      { id: '3', title: '状态未知', status: 'todo', ownerCatId: 'codex' },
      { id: '4', title: '已登记等待', status: 'blocked', ownerCatId: 'codex', hasActiveWait: true },
    ],
  });
  assert.match(text, /自己的待办.*\[未挂等待\]/);
  assert.doesNotMatch(text, /(?:别猫的待办|状态未知|已登记等待).*\[未挂等待\]/);
});

describe('summarizeActiveTasks', () => {
  it('returns top 3 non-done tasks sorted by recency', () => {
    const tasks = [
      { id: 't1', title: 'Fix Redis bug', status: 'todo', ownerCatId: 'opus', updatedAt: 1000 },
      { id: 't2', title: 'Review PR #900', status: 'in-progress', ownerCatId: 'codex', updatedAt: 3000 },
      { id: 't3', title: 'Write tests', status: 'done', ownerCatId: 'opus', updatedAt: 4000 },
      { id: 't4', title: 'Deploy v2', status: 'todo', ownerCatId: null, updatedAt: 2000 },
      { id: 't5', title: 'Phase F plan', status: 'in-progress', ownerCatId: 'opus', updatedAt: 5000 },
    ];
    const result = summarizeActiveTasks(tasks);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, 'Phase F plan');
    assert.ok(result.every((t) => t.status !== 'done'));
  });

  it('returns empty for no tasks', () => {
    assert.deepEqual(summarizeActiveTasks([]), []);
  });

  it('caps at 3 even with many active tasks', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      status: 'todo',
      ownerCatId: 'opus',
      updatedAt: i * 1000,
    }));
    assert.equal(summarizeActiveTasks(tasks).length, 3);
  });
});

describe('formatNavigationHeader', () => {
  it('renders exact other-member lifecycle state with its source handoff', () => {
    const header = formatNavigationHeader({
      tasks: [],
      currentCatId: 'codex',
      executionSituation: {
        kind: 'thread_execution_situation.v1',
        complete: true,
        activeRuns: [
          {
            phase: 'processing',
            targetId: 'kimi',
            invocationId: 'inv-kimi',
            responseMessageId: 'response-kimi',
            startedAt: 200,
            sources: [{ messageId: 'source-opus', from: { kind: 'agent', catId: 'opus' } }],
          },
        ],
      },
    });

    assert.match(header, /成员运行态（生命周期真相）/);
    assert.match(header, /\(kimi\).*来源 source-opus ← 布偶猫.*response=response-kimi.*invocation=inv-kimi/);
  });

  it('states that no other member is running only when the exact projection is complete', () => {
    const header = formatNavigationHeader({
      tasks: [],
      currentCatId: 'codex',
      executionSituation: {
        kind: 'thread_execution_situation.v1',
        complete: true,
        activeRuns: [
          {
            phase: 'processing',
            targetId: 'codex',
            invocationId: 'self-invocation',
            responseMessageId: 'self-response',
            startedAt: 100,
            sources: [{ messageId: 'source-user', from: { kind: 'user', userId: 'owner' } }],
          },
        ],
      },
    });

    assert.match(header, /成员运行态: 当前无其他成员执行/);
    assert.doesNotMatch(header, /self-invocation/);
  });

  it('does not infer execution from recent speech when the lifecycle join is incomplete', () => {
    const header = formatNavigationHeader({
      tasks: [],
      executionSituation: {
        kind: 'thread_execution_situation.v1',
        complete: false,
        activeRuns: [],
      },
    });

    assert.match(header, /当前无法完整验证（不按最近发言推断）/);
    assert.doesNotMatch(header, /当前无其他成员执行/);
  });

  it('formats exact source coordinates without repeating its body', () => {
    const header = formatNavigationHeader({
      sources: [
        {
          fromMessageId: 'm1',
          fromSpeakerDisplay: 'codex',
          timestamp: 1000,
        },
      ],
      tasks: [{ id: 't1', title: 'Fix Redis', status: 'in-progress', ownerCatId: 'opus' }],
    });
    assert.ok(header.includes('codex'));
    assert.ok(header.includes('messageId=m1'));
    assert.doesNotMatch(header, /传球|原文:/);
    assert.ok(header.includes('Fix Redis'));
  });

  it('shows stored source local time and UTC independently of current time', () => {
    const header = formatNavigationHeader({
      sources: [
        {
          fromMessageId: 'm1',
          fromSpeakerDisplay: 'co-creator',
          timestamp: Date.UTC(2026, 5, 1, 6, 20, 0, 0),
        },
      ],
      tasks: [],
    });
    assert.ok(header.includes(`${userLabel}本地 2026-05-31 23:20 America/Los_Angeles / 2026-06-01 06:20 UTC`), header);
  });

  it('injects a per-invocation temporal envelope with local and UTC dates', () => {
    const header = formatNavigationHeader({ tasks: [] }, { nowMs: Date.UTC(2026, 6, 6, 3, 14, 0, 0) });
    assert.ok(
      header.includes(`当前时间: ${userLabel}本地 2026-07-05 20:14 America/Los_Angeles / 2026-07-06 03:14 UTC`),
      header,
    );
    assert.ok(header.includes('relative terms use this now'), header);
  });

  it('handles missing baton and tasks gracefully', () => {
    const header = formatNavigationHeader({ tasks: [] });
    assert.ok(header.includes('[导航]'));
    assert.ok(!header.includes('undefined'));
  });

  it('does not include intent labels (KD-8)', () => {
    const header = formatNavigationHeader({
      sources: [
        {
          fromMessageId: 'm1',
          fromSpeakerDisplay: 'user1',
          timestamp: 1000,
        },
      ],
      tasks: [],
    });
    assert.ok(!header.includes('intent'));
    assert.ok(!header.includes('分类'));
    assert.ok(!header.includes('type:'));
  });

  it('shows task owner as 未分配 when null', () => {
    const header = formatNavigationHeader({
      tasks: [{ id: 't1', title: 'Deploy', status: 'todo', ownerCatId: null }],
    });
    assert.ok(header.includes('未分配'));
  });

  it('omits a missing work source instead of directing a thread lookup', () => {
    const header = formatNavigationHeader({
      tasks: [],
      threadId: 'thread-drill',
      truthSource: null,
    });

    assert.doesNotMatch(header, /真相源: 未定位|下一步|cat_cafe_get_thread_context/);
    assert.ok(!header.includes('query: "thread-drill"'), header);
    assert.ok(!header.includes('cat_cafe_search_evidence'), header);
  });

  it('renders the canonical source ref, not only its display label', () => {
    const header = formatNavigationHeader({
      tasks: [],
      threadId: 'thread-drill',
      truthSource: {
        label: 'F263 spec',
        ref: 'docs/features/F263-memory-system.md',
        provenance: 'canonical',
      },
    });

    assert.ok(header.includes('docs/features/F263-memory-system.md'), header);
  });
});
