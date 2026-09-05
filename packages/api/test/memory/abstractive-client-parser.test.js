import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const baseInput = {
  previousSummary: null,
  messages: [
    { id: 'msg-1', content: 'Hello', catId: 'opus', timestamp: Date.now() - 60000 },
    { id: 'msg-5', content: 'Goodbye', catId: 'user', timestamp: Date.now() },
  ],
  threadId: 'thread_test123',
};

describe('abstractive client endpoint and credential failures', () => {
  for (const scenario of ['versioned gateway', 'invalid scheme', 'resolver rejection']) {
    it(scenario, async () => {
      const { createAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
      const previousFetch = globalThis.fetch;
      const calls = [];
      const errors = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return Response.json({ content: [{ type: 'text', text: '# Fixture\n\nA useful summary.' }] });
      };
      try {
        const client = createAbstractiveClient(
          async () => {
            if (scenario === 'resolver rejection') throw new Error('Account identity rejected');
            return {
              mode: 'api_key',
              apiKey: 'FAKE_KEY',
              baseUrl:
                scenario === 'invalid scheme' ? 'file:///tmp/fixture' : 'https://gateway.invalid/v1?tenant=a#fragment',
            };
          },
          {
            info() {},
            error(message) {
              errors.push(message);
            },
          },
        );
        const result = await client(baseInput);
        if (scenario === 'versioned gateway') {
          assert.ok(result);
          assert.equal(calls[0].url, 'https://gateway.invalid/v1/messages?tenant=a#fragment');
          assert.equal(calls[0].init.redirect, 'error');
        } else {
          assert.equal(result, null);
          assert.equal(calls.length, 0);
          assert.equal(errors.length, 1);
        }
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
});

describe('parseNaturalLanguageOutput', () => {
  it('parses title + summary + 2 candidates (explicit + inferred)', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    const text = `# Memory Architecture Discussion

Discussed the architecture of the memory system, decided to use YAML as truth source, and learned about Redis isolation requirements for development environments.

## Durable Knowledge

[decision!] Knowledge Feed uses YAML as truth source — for git-trackability and audit trail
[lesson] Redis port isolation prevents data corruption — dev on 6398, prod on 6399`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].topicLabel, 'Memory Architecture Discussion');
    assert.ok(result.segments[0].summary.includes('architecture'));
    assert.equal(result.segments[0].candidates.length, 2);
    assert.equal(result.segments[0].candidates[0].confidence, 'explicit');
    assert.equal(result.segments[0].candidates[1].confidence, 'inferred');
  });

  it('uses first line as fallback when no # title', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    const text = `**Redis Isolation Strategy**

Summary of how we handle Redis port isolation in development and production environments.`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    assert.equal(result.segments[0].topicLabel, 'Redis Isolation Strategy');
  });

  it('caps candidates at MAX_CANDIDATES_PER_SEGMENT', async () => {
    const { parseNaturalLanguageOutput, MAX_CANDIDATES_PER_SEGMENT } = await import(
      '../../dist/domains/memory/AbstractiveSummaryClient.js'
    );

    const text = `# Many Decisions

Made lots of decisions today.

[decision!] First decision about architecture — important
[lesson] Second learning about testing — also important
[method] Third method about deployment — worth keeping`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    assert.ok(result.segments[0].candidates.length <= MAX_CANDIDATES_PER_SEGMENT);
    // explicit should be kept first
    assert.equal(result.segments[0].candidates[0].confidence, 'explicit');
  });

  it('filters implementation noise candidates', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    const text = `# Code Changes

Updated several files for the memory system.

[decision] Added mkdirSync before writeFileSync — prevents ENOENT
[lesson!] Silent catch blocks cause invisible data loss — always log errors in catch blocks`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    // "Added mkdirSync..." should be filtered as implementation noise (starts with code action verb + camelCase)
    // "Silent catch blocks..." should survive (durable lesson, no code identifiers)
    const candidates = result.segments[0].candidates ?? [];
    const titles = candidates.map((c) => c.title);
    assert.ok(!titles.some((t) => t.includes('mkdirSync')), 'implementation noise should be filtered');
    assert.ok(
      titles.some((t) => t.includes('Silent catch blocks')),
      'durable knowledge should survive',
    );
  });

  it('returns null for empty/whitespace input', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    assert.equal(parseNaturalLanguageOutput('', baseInput), null);
    assert.equal(parseNaturalLanguageOutput('   ', baseInput), null);
    assert.equal(parseNaturalLanguageOutput('short', baseInput), null);
  });
});
