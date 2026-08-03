import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  collectPawFeelMessages,
  inspectDeclaredPawFeelMessage,
  inspectPawFeelMessage,
} from '../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';

const T0 = 1_700_000_000_000;

function message(overrides = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-source',
    userId: 'u1',
    catId: 'codex-sol',
    content: '[爪感差: rg+输出太吵]',
    mentions: [],
    timestamp: T0,
    ...overrides,
  };
}

function digest(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

describe('F278 canonical paw-feel source', () => {
  it('builds digest identity and disambiguates byte-identical markers by ordinal', () => {
    const raw = '[爪感差: rg+输出太吵]';
    const inspected = inspectPawFeelMessage(
      message({
        content: `${raw} 中间 ${raw}`,
      }),
    );

    assert.equal(inspected.kind, 'canonical');
    assert.deepEqual(
      inspected.candidates.map((candidate) => ({
        signalId: candidate.signalId,
        markerDigest: candidate.markerDigest,
        sameDigestOrdinal: candidate.sameDigestOrdinal,
        markerIndex: candidate.markerIndex,
      })),
      [
        {
          signalId: `message-1:${digest(raw)}:0`,
          markerDigest: digest(raw),
          sameDigestOrdinal: 0,
          markerIndex: 0,
        },
        {
          signalId: `message-1:${digest(raw)}:1`,
          markerDigest: digest(raw),
          sameDigestOrdinal: 1,
          markerIndex: 1,
        },
      ],
    );
  });

  it('keeps existing identities when a newly recognized different marker appears earlier', () => {
    const existingRaw = '[爪感差: rg+输出太吵]';
    const before = inspectPawFeelMessage(message({ content: existingRaw }));
    const after = inspectPawFeelMessage(message({ content: `[爪感差: new-tool+新现象] ${existingRaw}` }));

    assert.equal(before.kind, 'canonical');
    assert.equal(after.kind, 'canonical');
    assert.equal(before.candidates[0].signalId, after.candidates[1].signalId);
    assert.equal(before.candidates[0].markerIndex, 0);
    assert.equal(after.candidates[1].markerIndex, 1, 'markerIndex is navigation-only');
  });

  it('separates canonical reports from user quotes and copied cross-thread markers', () => {
    assert.deepEqual(inspectPawFeelMessage(message({ catId: null })), { kind: 'ignored' });

    const copied = inspectPawFeelMessage(
      message({
        threadId: 'thread-target',
        extra: { crossPost: { sourceThreadId: 'thread-source' } },
      }),
    );
    assert.deepEqual(copied, { kind: 'cross_post_copy', markerCount: 1 });

    const legacySelfRef = inspectPawFeelMessage(
      message({
        extra: { crossPost: { sourceThreadId: 'thread-source' } },
      }),
    );
    assert.equal(legacySelfRef.kind, 'canonical');
    assert.equal(legacySelfRef.candidates.length, 1);
  });

  it('filters deterministic placeholders and escapes but keeps ambiguous Markdown contexts auditable', () => {
    assert.deepEqual(inspectPawFeelMessage(message({ content: '\\[爪感差: rg+escaped example]' })), {
      kind: 'ignored',
    });
    assert.deepEqual(inspectPawFeelMessage(message({ content: '[爪感差: 工具+现象]' })), {
      kind: 'ignored',
    });

    for (const content of [
      '`[爪感差: rg+inline bytes may be a real report]`',
      '```\n[爪感差: rg+fenced bytes may be a real report]\n```',
      '> [爪感差: rg+quoted bytes may be a real report]',
      '教学例子 `[爪感差: rg+same bytes]`；真实上报 `[爪感差: rg+same bytes]`',
    ]) {
      const inspected = inspectPawFeelMessage(message({ content }));
      assert.equal(inspected.kind, 'canonical');
      assert.equal(inspected.captureAssessment, 'ambiguous');
    }
  });

  it('typed intent confirms only standalone report lines while preserving legacy digest ordinals', () => {
    const raw = '[爪感差: rg+same bytes]';
    const source = message({
      content: `教学内联例子 \`${raw}\`\n\n${raw}`,
    });
    const legacy = inspectPawFeelMessage(source);
    const declared = inspectDeclaredPawFeelMessage(source);

    assert.equal(legacy.kind, 'canonical');
    assert.equal(legacy.candidates.length, 2);
    assert.equal(declared.kind, 'canonical');
    assert.equal(declared.candidates.length, 1);
    assert.equal(declared.candidates[0].sameDigestOrdinal, 1);
    assert.equal(declared.candidates[0].signalId, legacy.candidates[1].signalId);
  });

  it('paginates the complete timeline window without duplicate messages', async () => {
    const store = new MessageStore();
    for (let index = 0; index < 5; index += 1) {
      store.append({
        userId: 'u1',
        catId: 'codex-sol',
        content: `[爪感差: tool${index}+现象${index}]`,
        mentions: [],
        timestamp: T0 + index,
        threadId: 'thread-source',
      });
    }

    const messages = await collectPawFeelMessages(store, T0, T0 + 100, { pageSize: 2 });
    assert.equal(messages.length, 5);
    assert.equal(new Set(messages.map((entry) => entry.id)).size, 5);
  });
});
