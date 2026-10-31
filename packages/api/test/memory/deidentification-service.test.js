import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('DeidentificationService', () => {
  let DeidentificationService;

  before(async () => {
    ({ DeidentificationService } = await import('../../dist/domains/memory/deidentification-service.js'));
  });

  it('replaces absolute project path with [PROJECT]', () => {
    const svc = new DeidentificationService('/home/user/my-cool-app');
    const result = svc.sanitize({
      anchor: 'lesson-1',
      kind: 'lesson',
      status: 'active',
      title: 'Bug in /home/user/my-cool-app/src/index.ts',
      summary: 'Found issue at /home/user/my-cool-app/package.json',
      keywords: ['bug', '/home/user/my-cool-app'],
      updatedAt: '2026-04-10T00:00:00Z',
    });
    assert.ok(!result.sanitizedTitle.includes('/home/user/my-cool-app'));
    assert.ok(result.sanitizedTitle.includes('[PROJECT]'));
    assert.ok(!result.sanitizedSummary.includes('/home/user/my-cool-app'));
    assert.ok(result.removedPatterns.length > 0);
  });

  it('replaces URLs with [URL]', () => {
    const svc = new DeidentificationService('/tmp/proj');
    const result = svc.sanitize({
      anchor: 'lesson-2',
      kind: 'lesson',
      status: 'active',
      title: 'API endpoint issue',
      summary: 'See https://internal.company.com/api/v2/users for details',
      updatedAt: '2026-04-10T00:00:00Z',
    });
    assert.ok(!result.sanitizedSummary.includes('https://internal.company.com'));
    assert.ok(result.sanitizedSummary.includes('[URL]'));
  });

  it('preserves technical terms and methodology content', () => {
    const svc = new DeidentificationService('/tmp/proj');
    const result = svc.sanitize({
      anchor: 'lesson-3',
      kind: 'lesson',
      status: 'active',
      title: 'Redis keyPrefix pitfall',
      summary: 'ioredis keyPrefix does not apply to eval/evalsha commands. Use explicit prefix in Lua scripts.',
      keywords: ['redis', 'ioredis', 'keyPrefix'],
      updatedAt: '2026-04-10T00:00:00Z',
    });
    assert.ok(result.sanitizedTitle.includes('Redis keyPrefix'));
    assert.ok(result.sanitizedSummary.includes('ioredis'));
    assert.ok(result.sanitizedSummary.includes('Lua scripts'));
    assert.deepEqual(result.sanitizedKeywords, ['redis', 'ioredis', 'keyPrefix']);
  });

  it('replaces project directory name in text', () => {
    const svc = new DeidentificationService('/home/user/acme-billing');
    const result = svc.sanitize({
      anchor: 'lesson-4',
      kind: 'lesson',
      status: 'active',
      title: 'acme-billing migration failed due to schema drift',
      summary: 'The acme-billing project had outdated schemas.',
      updatedAt: '2026-04-10T00:00:00Z',
    });
    assert.ok(!result.sanitizedTitle.includes('acme-billing'));
    assert.ok(result.sanitizedTitle.includes('[PROJECT]'));
  });

  it('sanitizes keywords array', () => {
    const svc = new DeidentificationService('/home/user/secret-project');
    const result = svc.sanitize({
      anchor: 'lesson-5',
      kind: 'lesson',
      status: 'active',
      title: 'Pattern found',
      keywords: ['secret-project', 'typescript', 'https://example.com/api'],
      updatedAt: '2026-04-10T00:00:00Z',
    });
    assert.ok(!result.sanitizedKeywords.includes('secret-project'));
    assert.ok(result.sanitizedKeywords.includes('typescript'));
  });

  it('returns original item reference', () => {
    const svc = new DeidentificationService('/tmp/proj');
    const original = {
      anchor: 'lesson-6',
      kind: 'lesson',
      status: 'active',
      title: 'Test',
      updatedAt: '2026-04-10T00:00:00Z',
    };
    const result = svc.sanitize(original);
    assert.equal(result.original, original);
  });
});
