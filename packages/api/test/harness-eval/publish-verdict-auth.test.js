import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * F192 Phase H — AC-H3: callback auth + domain allowlist tests.
 * Extracted from publish-verdict.test.js per 350-line hard limit.
 */
describe('handlePublishVerdict — AC-H3 auth + domain allowlist', () => {
  /** @type {string} fixture harness-feedback root with 5 domains registered */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 401 unauthenticated when catId not provided', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      { packet: buildPacket({ domainId: 'eval:a2a' }), domain: 'eval:a2a', catId: '' },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 401);
    assert.equal(result.error, 'unauthenticated');
  });

  it('returns 403 not_allowed when catId is not the registered eval cat for this domain', async () => {
    // eval:a2a registered cat is 'codex'; 'opus-47' is eval:memory's cat
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      { packet: buildPacket({ domainId: 'eval:a2a' }), domain: 'eval:a2a', catId: 'opus-47' },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'not_allowed');
    assert.match(result.detail, /opus-47/);
    assert.match(result.detail, /codex/);
  });

  it('passes auth when catId matches the registered eval cat for this domain', async () => {
    // PR-2 (砚砚 R1 P1): handler now requires explicit deps.generator; without it
    // → 501 unsupported_generator (not 500 from default-throw). This test asserts
    // auth passes → 501 (= got PAST auth to generator check).
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root /* generator omitted */ },
      {
        packet: buildPacket({ domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );
    assert.ok('error' in result, 'should fail at later AC, not at auth');
    assert.notEqual(result.error, 'not_allowed', 'auth must NOT reject codex for eval:a2a');
    assert.notEqual(result.error, 'unauthenticated', 'auth must NOT 401 on valid catId');
    // Post-auth failure: 501 unsupported_generator (no generator) is the new expected path.
    assert.equal(result.status, 501);
    assert.equal(result.error, 'unsupported_generator');
  });

  // 砚砚 R6 P1 + cloud R6 P1: respect OQ-20 Redis evalCat override (symmetric
  // with handleTriggerNow — overridden cat receives invocation AND can publish).
  it('allows override cat to publish when OQ-20 Redis override is set (砚砚 R6 P1)', async () => {
    // Mock Redis returning override → 'opus-47' for eval:a2a (static is 'codex')
    const mockRedis = {
      get: async (key) => {
        if (key === 'eval-domain:eval:a2a:evalCat-override') {
          return JSON.stringify({ catId: 'opus-47', handle: '@opus47', model: 'opus-4.7' });
        }
        return null;
      },
    };
    // Override cat 'opus-47' should now PASS auth (would have been 403 before fix)
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, redis: mockRedis /* generator omitted */ },
      {
        packet: buildPacket({ domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'opus-47',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );
    assert.ok('error' in result, 'should fail at later AC (501 no generator), not at auth');
    assert.notEqual(result.error, 'not_allowed', 'override cat must NOT be rejected by auth');
    // PR-2: post-auth handler returns 501 when generator omitted (was 500 from default-throw).
    assert.equal(result.status, 501);
    assert.equal(result.error, 'unsupported_generator');
  });

  it('rejects static cat with 403 when override is set to different cat (砚砚 R6 P1)', async () => {
    const mockRedis = {
      get: async (key) => {
        if (key === 'eval-domain:eval:a2a:evalCat-override') {
          return JSON.stringify({ catId: 'opus-47', handle: '@opus47', model: 'opus-4.7' });
        }
        return null;
      },
    };
    // Static 'codex' should now FAIL because override redirected to 'opus-47'
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, redis: mockRedis },
      {
        packet: buildPacket({ domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'not_allowed');
    assert.match(result.detail, /opus-47.*override|override.*opus-47/);
  });

  it('falls back to static cat when Redis read fails (degradation)', async () => {
    const flakyRedis = {
      get: async () => {
        throw new Error('redis connection lost');
      },
    };
    // Static 'codex' should PASS auth (Redis failed silently, fallback OK)
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, redis: flakyRedis },
      {
        packet: buildPacket({ domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );
    assert.ok('error' in result);
    assert.notEqual(result.error, 'not_allowed', 'static cat must still pass when Redis errors');
    // PR-2: post-auth handler returns 501 when generator omitted (was 500 generator_failed from default-throw).
    assert.equal(result.error, 'unsupported_generator');
  });

  // 砚砚 R1 P1 #2: eval:a2a requires sourceRefs, tool NEVER 造 evidence
  it('returns 400 missing_evidence_refs when eval:a2a publish lacks sourceRefs', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      {
        packet: buildPacket({ domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: {}, // empty - cat forgot to provide evidence sources
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'missing_evidence_refs');
    assert.match(result.detail, /snapshotName|attributionName|fabricate/i);
  });

  // 砚砚 R3 P2 cloud: type-check sourceRefs.* before basename() — non-string
  // truthy values (number, object, array) must return 400 controlled error,
  // not crash basename() with TypeError → 500
  it('returns 400 invalid_source_ref for non-string truthy sourceRefs.* (number/object/array)', async () => {
    for (const bad of [42, true, { name: 'x' }, ['x']]) {
      for (const field of ['snapshotName', 'attributionName']) {
        const sourceRefs = { snapshotName: 'ok.yaml', attributionName: 'ok.yaml' };
        sourceRefs[field] = bad;
        const result = await handlePublishVerdict(
          { harnessFeedbackRoot: root },
          { packet: buildPacket({ domainId: 'eval:a2a' }), domain: 'eval:a2a', catId: 'codex', sourceRefs },
        );
        assert.ok('error' in result, `${field}=${JSON.stringify(bad)} should reject`);
        assert.equal(result.status, 400, `must be 400 not 500`);
        assert.equal(result.error, 'invalid_source_ref');
        assert.match(result.detail, /must be strings/);
      }
    }
  });

  // 砚砚 R2 P2 cloud: sourceRefs must be basenames; path-traversal rejected with allowlist
  it('returns 400 invalid_source_ref for path-traversal in snapshotName/attributionName', async () => {
    for (const bad of ['../etc/passwd', '/etc/passwd', 'subdir/foo', '..', '.', '']) {
      for (const field of ['snapshotName', 'attributionName']) {
        const sourceRefs = { snapshotName: 'ok.yaml', attributionName: 'ok.yaml' };
        sourceRefs[field] = bad;
        const result = await handlePublishVerdict(
          { harnessFeedbackRoot: root },
          { packet: buildPacket({ domainId: 'eval:a2a' }), domain: 'eval:a2a', catId: 'codex', sourceRefs },
        );
        assert.ok('error' in result, `${field}='${bad}' should reject`);
        // empty string '' is caught by missing_evidence_refs (presence check) — both are 400
        assert.equal(result.status, 400, `${field}='${bad}' must be 400`);
        if (bad !== '') {
          assert.equal(result.error, 'invalid_source_ref', `${field}='${bad}' → invalid_source_ref`);
          assert.match(result.detail, new RegExp(field), `error must call out ${field}`);
        }
      }
    }
  });
});
