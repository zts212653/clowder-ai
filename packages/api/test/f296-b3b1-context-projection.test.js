// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { assembleIncrementalContext, shouldPersistContextBriefing } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

const HISTORY_BUDGET = 500_000;

function seedMessages(messageStore, count) {
  const baseTs = Date.now() - count * 60_000;
  for (let index = 0; index < count; index += 1) {
    messageStore.append({
      threadId: 'thread-b3b1',
      userId: 'user-1',
      catId: null,
      content: `message ${index} about redis deployment continuity`,
      mentions: [],
      timestamp: baseTs + index * 60_000,
    });
  }
}

function createDeps(messageCount) {
  const messageStore = new MessageStore();
  seedMessages(messageStore, messageCount);
  const calls = { evidence: 0, threadMemory: 0 };
  return {
    calls,
    deps: {
      services: {},
      messageStore,
      deliveryCursorStore: new DeliveryCursorStore(),
      evidenceStore: {
        async search() {
          calls.evidence += 1;
          return [
            {
              anchor: 'F999',
              kind: 'feature',
              status: 'active',
              title: 'heuristic candidate',
              summary: 'must remain outside the packet',
              sourcePath: 'docs/features/F999.md',
              keywords: [],
            },
          ];
        },
      },
      invocationDeps: {
        threadStore: {
          async get() {
            return { id: 'thread-b3b1', title: 'F296 continuity', userId: 'user-1' };
          },
          async getThreadMemory() {
            calls.threadMemory += 1;
            return {
              v: 1,
              summary: 'historical automatic summary must not enter a canonical cold packet',
              sessionsIncorporated: 4,
              updatedAt: Date.now(),
            };
          },
        },
      },
    },
  };
}

function projection(contextMode) {
  return {
    coordinate: {
      providerCarrier: { provider: 'codex', carrier: 'exec_json' },
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
    },
    contextEpoch: 7,
    contextMode,
    transition: contextMode === 'cold' ? 'fresh' : 'resumed',
    reason: contextMode === 'cold' ? 'resume_rejected' : 'resume_confirmed',
  };
}

async function assemble(deps, contextProjection, effectiveMaxContextTokens = HISTORY_BUDGET) {
  return assembleIncrementalContext(deps, 'user-1', 'thread-b3b1', 'opus', undefined, 'play', {
    effectiveMaxContextTokens,
    ...(contextProjection ? { contextProjection } : {}),
  });
}

describe('F296 B3b-1: contextMode and deltaSize stay orthogonal', () => {
  test('persisted briefing remains a large-delta surface instead of a per-cold-turn receipt', () => {
    const coverageMap = {
      omitted: { count: 1, timeRange: { from: 1, to: 2 }, participants: ['user-1'] },
      burst: { count: 1, timeRange: { from: 2, to: 3 } },
      anchorIds: [],
      threadMemory: null,
      recallPointer: { candidateCount: 0 },
    };

    assert.equal(shouldPersistContextBriefing({ coverageMap }), true, 'legacy smart-window behavior survives');
    assert.equal(
      shouldPersistContextBriefing({
        coverageMap,
        surfaceProjection: {
          ...projection('cold'),
          deltaSize: 'large',
          presentationCounts: { T0: 0, T1: 0, T2: 0, invalid: 0 },
        },
      }),
      true,
      'cold large keeps the briefing surface',
    );
    assert.equal(
      shouldPersistContextBriefing({
        coverageMap,
        surfaceProjection: {
          ...projection('cold'),
          deltaSize: 'small',
          presentationCounts: { T0: 0, T1: 0, T2: 0, invalid: 0 },
        },
      }),
      false,
      'cold-first must not create a durable message on every small turn',
    );
    assert.equal(
      shouldPersistContextBriefing({
        coverageMap,
        surfaceProjection: {
          ...projection('hot'),
          deltaSize: 'large',
          presentationCounts: { T0: 0, T1: 0, T2: 0, invalid: 0 },
        },
      }),
      false,
      'hot cannot mint a cold briefing even if a malformed producer supplies coverage',
    );
  });

  test('cold + small still rebuilds a bounded cold packet without heuristic recall bodies', async () => {
    const { deps, calls } = createDeps(3);
    const result = await assemble(deps, projection('cold'));

    assert.equal(result.surfaceProjection.contextMode, 'cold');
    assert.equal(result.surfaceProjection.deltaSize, 'small');
    assert.match(result.contextText, /"contextMode":"cold"/);
    assert.match(result.contextText, /"deltaSize":"small"/);
    assert.match(result.contextText, /对话历史增量 - 智能窗口/, 'cold chooses rebuild independent of volume');
    assert.doesNotMatch(result.contextText, /\[Thread Memory/);
    assert.doesNotMatch(result.contextText, /\[Anchor /);
    assert.doesNotMatch(result.contextText, /\[Related evidence/);
    assert.equal(calls.threadMemory, 0, 'cold packet cannot consume an automatic memory summary');
    assert.equal(calls.evidence, 0, 'cold packet carries an exact drill, not an eager heuristic recall');
  });

  test('hot + large shapes only unread messages and never calls cold recall producers', async () => {
    const { deps, calls } = createDeps(30);
    const result = await assemble(deps, projection('hot'));

    assert.equal(result.surfaceProjection.contextMode, 'hot');
    assert.equal(result.surfaceProjection.deltaSize, 'large');
    assert.match(result.contextText, /"contextMode":"hot"/);
    assert.match(result.contextText, /"deltaSize":"large"/);
    assert.match(result.contextText, /对话历史增量 - 智能窗口/, 'large delta is still shaped');
    assert.doesNotMatch(result.contextText, /\[Thread Memory/);
    assert.doesNotMatch(result.contextText, /\[Related evidence/);
    assert.equal(result.coverageMap, undefined, 'hot does not mint a cold briefing projection');
    assert.equal(calls.threadMemory, 0, 'hot large must not read thread memory');
    assert.equal(calls.evidence, 0, 'hot large must not run evidence recall');
  });

  test('cold + large keeps an omitted high-similarity message behind the exact drill', async () => {
    const { deps } = createDeps(30);
    const result = await assemble(deps, projection('cold'));

    assert.doesNotMatch(
      result.contextText,
      /message 0 about redis deployment continuity/,
      'an unbound omitted message cannot re-enter as a verbatim anchor',
    );
    assert.match(result.contextText, /search_evidence\(/, 'the omitted range remains retrievable by exact drill');
  });

  test('hot + small keeps the warm unread path', async () => {
    const { deps } = createDeps(3);
    const result = await assemble(deps, projection('hot'));

    assert.equal(result.surfaceProjection.contextMode, 'hot');
    assert.equal(result.surfaceProjection.deltaSize, 'small');
    assert.match(result.contextText, /"contextMode":"hot"/);
    assert.match(result.contextText, /"deltaSize":"small"/);
    assert.match(result.contextText, /对话历史增量 - 未发送过 3 条/);
    assert.doesNotMatch(result.contextText, /智能窗口/);
  });

  test('a legacy volume-only caller cannot fabricate an epoch-owned continuity header', async () => {
    const { deps } = createDeps(30);
    const result = await assemble(deps, undefined);

    assert.doesNotMatch(result.contextText, /\[Context Continuity\]/);
    assert.doesNotMatch(result.contextText, /legacy_volume_path/);
  });

  test('the epoch decision survives an exhausted unread budget', async () => {
    const { deps } = createDeps(3);
    const result = await assemble(deps, projection('hot'), 0);

    assert.match(result.contextText, /"contextEpoch":7/);
    assert.match(result.contextText, /"contextMode":"hot"/);
    assert.match(result.contextText, /"deltaSize":"small"/);
  });
});
