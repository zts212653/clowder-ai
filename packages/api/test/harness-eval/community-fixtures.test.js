import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { parseCommunityEvalDomainEntry } from '../../dist/infrastructure/harness-eval/domain/community-eval-domain.js';
import { parseSanitizedIssuePacket } from '../../dist/infrastructure/harness-eval/domain/community-issue-packet.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '../../../../docs/harness-feedback/eval-domains/community-fixtures');

describe('E-community fixtures (AC-E15)', () => {
  describe('sanitized-issue-packet-example.json', () => {
    it('passes parseSanitizedIssuePacket schema validation', () => {
      const raw = JSON.parse(readFileSync(resolve(FIXTURES_DIR, 'sanitized-issue-packet-example.json'), 'utf8'));
      const packet = parseSanitizedIssuePacket(raw);
      assert.equal(packet.id, 'sip-community-001');
      assert.equal(packet.domainId, 'eval:code-review-quality');
      assert.equal(packet.verdict, 'fix');
    });

    it('contains no internal Clowder AI thread IDs', () => {
      const raw = readFileSync(resolve(FIXTURES_DIR, 'sanitized-issue-packet-example.json'), 'utf8');
      // Internal thread IDs follow pattern thread_eval_* or thread_*
      assert.ok(!raw.includes('thread_eval_'));
      assert.ok(!raw.includes('thread_'));
    });

    it('contains no Clowder AI internal cat model names', () => {
      const raw = readFileSync(resolve(FIXTURES_DIR, 'sanitized-issue-packet-example.json'), 'utf8');
      const internalModels = ['claude-opus', 'claude-sonnet', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3', 'gemini-3', 'gemini-2'];
      for (const model of internalModels) {
        assert.ok(!raw.toLowerCase().includes(model), `fixture should not contain internal model name: ${model}`);
      }
    });

    it('contains no internal feature IDs (F followed by 3 digits)', () => {
      const raw = readFileSync(resolve(FIXTURES_DIR, 'sanitized-issue-packet-example.json'), 'utf8');
      // Internal feature IDs: F167, F192, F200, etc.
      assert.ok(!/\bF\d{3}\b/.test(raw), 'fixture should not contain internal feature IDs');
    });
  });

  describe('custom-domain-example.yaml', () => {
    it('passes parseCommunityEvalDomainEntry schema validation', () => {
      const raw = parseYaml(readFileSync(resolve(FIXTURES_DIR, 'custom-domain-example.yaml'), 'utf8'));
      const entry = parseCommunityEvalDomainEntry(raw);
      assert.equal(entry.domainId, 'eval:code-review-quality');
      assert.equal(entry.sourceAdapter, 'community-custom');
      assert.equal(entry.frequency, 'weekly');
    });

    it('uses community-custom sourceAdapter (not internal adapter)', () => {
      const raw = parseYaml(readFileSync(resolve(FIXTURES_DIR, 'custom-domain-example.yaml'), 'utf8'));
      const entry = parseCommunityEvalDomainEntry(raw);
      const internalAdapters = ['f167-runtime-eval', 'f200-f188-memory-eval', 'sop-trace-eval'];
      assert.ok(
        !internalAdapters.includes(entry.sourceAdapter),
        'community fixture should not use internal sourceAdapter',
      );
    });
  });
});
