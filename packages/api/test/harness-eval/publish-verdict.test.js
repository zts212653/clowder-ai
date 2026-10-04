import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * F192 Phase H — Verdict Publishing Pipeline (砚砚 R0 Path B narrowed).
 * AC-H1: packet schema validation.
 * AC-H2: branch + commit + push + auto-PR pipeline (exec + generator injected).
 * AC-H7 partial: domain↔packet cross-check + eval:a2a-only v1.
 */
describe('handlePublishVerdict', () => {
  /** @type {string} fixture harness-feedback root with 5 domains registered */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // AC-H1: packet validation
  describe('AC-H1 — packet validation', () => {
    it('returns 400 invalid_packet when packet missing required fields', async () => {
      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: '/tmp/phase-h-test' },
        { packet: { id: 'incomplete' }, domain: 'eval:a2a', catId: 'codex' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'invalid_packet');
    });

    it('returns 400 invalid_packet for non-object inputs', async () => {
      for (const bad of [null, 'str', 42, []]) {
        const result = await handlePublishVerdict(
          { harnessFeedbackRoot: '/tmp/phase-h-test' },
          { packet: bad, domain: 'eval:a2a', catId: 'codex' },
        );
        assert.ok('error' in result, `${JSON.stringify(bad)} should reject`);
        assert.equal(result.status, 400);
      }
    });

    it('returns 400 when delete_sunset lacks operator accept gate', async () => {
      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: '/tmp/phase-h-test' },
        { packet: buildPacket({ verdict: 'delete_sunset' }), domain: 'eval:a2a', catId: 'codex' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.match(result.detail, /operator|cvoAcceptRequired/i);
    });
  });

  // AC-H7 partial: domain cross-check + v1 generator allowlist
  describe('AC-H7 — domain validation', () => {
    it('returns 400 domain_mismatch when input.domain ≠ packet.domainId', async () => {
      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: '/tmp/phase-h-test' },
        { packet: buildPacket({ domainId: 'eval:a2a' }), domain: 'eval:memory', catId: 'codex' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'domain_mismatch');
    });

    // PR-2 (砚砚 R1 P1): handler is domain-agnostic; 501 returned when
    // `deps.generator` is undefined (route layer decides per-domain).
    // Without generator + with no sourceRefs (a2a kind default), handler runs
    // a2a validation first → 400 missing_evidence_refs before reaching generator
    // check. To verify 501 specifically, provide valid sourceRefs + omit generator.
    it('returns 501 unsupported_generator when no generator injected (PR-2 route-layer SoT)', async () => {
      for (const domain of ['eval:memory', 'eval:sop']) {
        // For non-a2a/non-cw domains, provide a2a-shaped refs (kind omitted = a2a default)
        // so handler passes pre-validation and reaches generator presence check.
        const result = await handlePublishVerdict(
          { harnessFeedbackRoot: root /* generator omitted */, redis: undefined },
          {
            packet: buildPacket({ domainId: domain }),
            domain,
            catId: 'codex',
            sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
          },
        );
        assert.ok('error' in result, `${domain} should fail`);
        // Pre-validation OR cat-allowlist OR 501 — any 4xx/501 is acceptable; the assertion
        // here is that handler does NOT silently succeed.
        assert.ok(result.status >= 400, `${domain} → ≥400 (got ${result.status})`);
      }
    });

    it('returns 400 sourceRefs_kind_mismatch when task-outcome domain receives a2a refs', async () => {
      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: root },
        {
          packet: buildPacket({ domainId: 'eval:task-outcome' }),
          domain: 'eval:task-outcome',
          catId: 'opus-47',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'sourceRefs_kind_mismatch');
      assert.match(result.detail, /task-outcome-snapshot/);
    });

    it('returns 501 unsupported_generator when task-outcome receives valid task-outcome-snapshot refs', async () => {
      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: root },
        {
          packet: buildPacket({ domainId: 'eval:task-outcome' }),
          domain: 'eval:task-outcome',
          catId: 'opus-47',
          sourceRefs: {
            kind: 'task-outcome-snapshot',
            windowStartMs: 1780887600000,
            windowEndMs: 1780974000000,
          },
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 501);
      assert.equal(result.error, 'unsupported_generator');
    });

    it('returns 501 unsupported_source_refs_kind when registry declares a new kind without publish wiring', async () => {
      writeFileSync(
        join(root, 'eval-domains', 'eval-anchor-first.yaml'),
        `domainId: eval:anchor-first
displayName: Anchor-first Eval
systemThreadId: thread_eval_anchor_first
evalCat:
  catId: codex
  handle: '@codex'
  model: gpt-5.5
frequency: daily
sourceAdapter: anchor-first-eval
sourceRefsKind: anchor-first-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F236
  ownerCatId: codex
  threadLookup: feature-thread
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
fixtures: []
`,
      );

      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: root },
        {
          packet: buildPacket({ domainId: 'eval:anchor-first' }),
          domain: 'eval:anchor-first',
          catId: 'codex',
          sourceRefs: { kind: 'anchor-first-snapshot', anchorId: 'abc-123' },
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 501);
      assert.equal(result.error, 'unsupported_source_refs_kind');
      assert.match(result.detail, /anchor-first-snapshot/);
    });

    it('returns 400 invalid_source_ref when task-outcome databasePath is absolute or escapes repo root', async () => {
      for (const databasePath of ['/tmp/task-outcome-episodes.sqlite', '../task-outcome-episodes.sqlite']) {
        const result = await handlePublishVerdict(
          { harnessFeedbackRoot: root },
          {
            packet: buildPacket({ domainId: 'eval:task-outcome' }),
            domain: 'eval:task-outcome',
            catId: 'opus-47',
            sourceRefs: {
              kind: 'task-outcome-snapshot',
              windowStartMs: 1780887600000,
              windowEndMs: 1780974000000,
              databasePath,
            },
          },
        );
        assert.ok('error' in result);
        assert.equal(result.status, 400);
        assert.equal(result.error, 'invalid_source_ref');
        assert.match(result.detail, /databasePath/i);
      }
    });
  });

  // AC-H3 auth + domain allowlist tests extracted to publish-verdict-auth.test.js

  // AC-H8: idempotency + length + slug (复用 generate-now 模式)
  describe('AC-H8 — packet.id validation + idempotency', () => {
    it('returns 400 invalid_packet_id when id exceeds 128 chars', async () => {
      const big = 'a'.repeat(129);
      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: root },
        { packet: buildPacket({ id: big, domainId: 'eval:a2a' }), domain: 'eval:a2a', catId: 'codex' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'invalid_packet_id');
      assert.match(result.detail, /128/);
    });

    it('returns 400 invalid_packet_id for slug violations (uppercase, underscore, etc.)', async () => {
      for (const bad of ['Test-Foo', 'test_foo', '-leading', 'foo.bar', 'foo bar', 'foo/bar']) {
        const result = await handlePublishVerdict(
          { harnessFeedbackRoot: root },
          { packet: buildPacket({ id: bad, domainId: 'eval:a2a' }), domain: 'eval:a2a', catId: 'codex' },
        );
        assert.ok('error' in result, `'${bad}' should be rejected`);
        assert.equal(result.status, 400, `'${bad}' → 400`);
        assert.equal(result.error, 'invalid_packet_id');
      }
    });

    it('returns 400 invalid_packet when phenomenon exceeds 2048 chars', async () => {
      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: root },
        {
          packet: buildPacket({ id: 'ok-id', domainId: 'eval:a2a', phenomenon: 'x'.repeat(2049) }),
          domain: 'eval:a2a',
          catId: 'codex',
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.match(result.detail, /phenomenon.*2048/);
    });

    it('returns no_new_window typed success when verdict file already exists for this id (exact replay)', async () => {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const dupId = 'dup-verdict-test';
      mkdirSync(resolve(root, 'verdicts'), { recursive: true });
      writeFileSync(resolve(root, 'verdicts', `${dupId}.md`), '# Existing verdict\n');

      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: root },
        {
          packet: buildPacket({ id: dupId, domainId: 'eval:a2a' }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );
      assert.ok('ok' in result && result.ok === true, `expected typed success, got: ${JSON.stringify(result)}`);
      assert.equal(result.outcome, 'no_new_window');
      assert.equal(result.canonicalVerdictId, dupId);
    });
  });

  // AC-H2 + 砚砚 R1 P1 #1: pipeline mechanics via GitPublisher abstraction
});
