import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  loadCommunityDomains,
  parseCommunityEvalDomainEntry,
} from '../../dist/infrastructure/harness-eval/domain/community-eval-domain.js';

/** Minimal valid community domain entry. */
function makeDomain(overrides = {}) {
  return {
    domainId: 'eval:code-review-quality',
    displayName: 'Code Review Quality Eval',
    systemThreadId: 'thread_eval_code_review',
    evalCat: { catId: 'reviewer-bot', handle: '@reviewer-bot', model: 'community-model-v1' },
    frequency: 'weekly',
    sourceAdapter: 'community-custom',
    threadPolicy: {
      role: 'working-home',
      stateSot: 'registry',
      allowedContent: ['longitudinal-analysis', 'verdict-discussion'],
    },
    legacyScheduledTaskIds: [],
    sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
    ...overrides,
  };
}

describe('CommunityEvalDomainEntry', () => {
  describe('parseCommunityEvalDomainEntry', () => {
    it('accepts a valid community domain with custom domainId', () => {
      const entry = parseCommunityEvalDomainEntry(makeDomain());
      assert.equal(entry.domainId, 'eval:code-review-quality');
      assert.equal(entry.sourceAdapter, 'community-custom');
    });

    it('accepts any eval: prefixed domainId', () => {
      const entry = parseCommunityEvalDomainEntry(makeDomain({ domainId: 'eval:my-project-ci' }));
      assert.equal(entry.domainId, 'eval:my-project-ci');
    });

    it('rejects domainId without eval: prefix', () => {
      assert.throws(
        () => parseCommunityEvalDomainEntry(makeDomain({ domainId: 'custom:bad' })),
        /domainId must start with eval:/,
      );
    });

    it('rejects domainId with uppercase letters', () => {
      assert.throws(
        () => parseCommunityEvalDomainEntry(makeDomain({ domainId: 'eval:MyDomain' })),
        /domainId must start with eval:/,
      );
    });

    it('accepts optional handoffTargetResolver', () => {
      // Without resolver — valid
      const withoutResolver = parseCommunityEvalDomainEntry(makeDomain());
      assert.equal(withoutResolver.handoffTargetResolver, undefined);

      // With resolver — also valid
      const withResolver = parseCommunityEvalDomainEntry(
        makeDomain({
          handoffTargetResolver: {
            featureId: 'F999',
            ownerCatId: 'community-lead',
            threadLookup: 'feature-thread',
          },
        }),
      );
      assert.equal(withResolver.handoffTargetResolver?.featureId, 'F999');
    });

    it('requires sourceAdapter to be community-custom', () => {
      assert.throws(
        () => parseCommunityEvalDomainEntry(makeDomain({ sourceAdapter: 'f167-runtime-eval' })),
        /Invalid literal value/,
      );
    });

    it('accepts both daily and weekly frequency', () => {
      const daily = parseCommunityEvalDomainEntry(makeDomain({ frequency: 'daily' }));
      assert.equal(daily.frequency, 'daily');
      const weekly = parseCommunityEvalDomainEntry(makeDomain({ frequency: 'weekly' }));
      assert.equal(weekly.frequency, 'weekly');
    });
  });

  describe('loadCommunityDomains', () => {
    let tempDir;

    beforeEach(() => {
      tempDir = join(tmpdir(), `community-domains-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('returns empty array for missing directory', () => {
      const result = loadCommunityDomains('/nonexistent/path/that/does/not/exist');
      assert.deepEqual(result, []);
    });

    it('returns empty array for empty directory', () => {
      const result = loadCommunityDomains(tempDir);
      assert.deepEqual(result, []);
    });

    it('loads and validates YAML files from directory', () => {
      const yaml = `
domainId: eval:test-domain
displayName: Test Domain
systemThreadId: thread_eval_test
evalCat:
  catId: test-cat
  handle: "@test-cat"
  model: test-model-v1
frequency: daily
sourceAdapter: community-custom
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
legacyScheduledTaskIds: []
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
`;
      writeFileSync(join(tempDir, 'test-domain.yaml'), yaml);
      const result = loadCommunityDomains(tempDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].domainId, 'eval:test-domain');
    });

    it('skips non-YAML files', () => {
      writeFileSync(join(tempDir, 'readme.md'), '# Not a domain');
      writeFileSync(join(tempDir, 'data.json'), '{}');
      const result = loadCommunityDomains(tempDir);
      assert.deepEqual(result, []);
    });

    it('throws on invalid YAML content', () => {
      const badYaml = `
domainId: bad-no-eval-prefix
displayName: Bad
`;
      writeFileSync(join(tempDir, 'bad-domain.yaml'), badYaml);
      assert.throws(() => loadCommunityDomains(tempDir));
    });
  });
});
