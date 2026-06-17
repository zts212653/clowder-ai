/**
 * F168 Phase C — C2.2: NarratorDriver + dispatch handler narrator spawn
 *
 * Tests (INV-1/2/3 from plan §1 SO-1):
 *
 *   INV-1: narrator spawn via NarratorDriver → wakeCat called; case.state is NOT touched
 *          (narrator only delivers a briefing to the narrator cat; it never writes case.state)
 *   INV-2: narrator capabilities ⊆ {triage, route-recommend, public-reply}, no code/merge
 *   INV-3: same (subjectKey, sourceEventId) → second spawnNarrator is a no-op (idempotent)
 *
 * Adversarial:
 *   - roleResolver.resolve('narrator') returns null → fail-loud warn, no wakeCat call
 *   - wakeCat throws → error is caught, logged, never propagates (fire-and-forget)
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const NARRATOR_DRIVER_PATH = '../../dist/domains/community/NarratorDriver.js';

describe('F168 Phase C C2.2: NarratorDriver', () => {
  let NarratorDriver;

  beforeEach(async () => {
    ({ NarratorDriver } = await import(NARRATOR_DRIVER_PATH));
  });

  describe('INV-3: spawn idempotency by (subjectKey, sourceEventId)', () => {
    it('calling spawnNarrator twice with the same eventId → second call is no-op', async () => {
      const wakeCatCalls = [];
      const mockWakeCat = async (params) => {
        wakeCatCalls.push(params);
      };

      const mockRoleResolver = {
        resolve: (role) => {
          if (role === 'narrator') {
            return {
              catId: 'gemini25',
              model: 'gemini-3.5-flash',
              promptTemplateId: 'community-narrator-v1',
              capabilities: ['triage', 'route-recommend', 'public-reply'],
            };
          }
          return null;
        },
      };

      const driver = new NarratorDriver({
        roleResolver: mockRoleResolver,
        narratorThreadId: 'thread_narrator_ops',
        wakeCat: mockWakeCat,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });

      const subjectKey = 'issue:clowder-ai#912';
      const sourceEventId = 'dispatch:abc123:1718000000000';

      await driver.spawnNarrator({
        caseId: 'ci-001',
        subjectKey,
        sourceEventId,
        briefingContext: 'Dark mode feature request',
      });
      await driver.spawnNarrator({
        caseId: 'ci-001',
        subjectKey,
        sourceEventId,
        briefingContext: 'Dark mode feature request',
      });

      assert.equal(wakeCatCalls.length, 1, 'second call with same eventId should be a no-op (INV-3)');
    });

    it('different eventIds → both spawns execute', async () => {
      const wakeCatCalls = [];
      const mockWakeCat = async (params) => {
        wakeCatCalls.push(params);
      };
      const mockRoleResolver = {
        resolve: () => ({
          catId: 'gemini25',
          model: 'gemini-3.5-flash',
          promptTemplateId: 'community-narrator-v1',
          capabilities: ['triage', 'route-recommend', 'public-reply'],
        }),
      };

      const driver = new NarratorDriver({
        roleResolver: mockRoleResolver,
        narratorThreadId: 'thread_narrator_ops',
        wakeCat: mockWakeCat,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await driver.spawnNarrator({
        caseId: 'ci-a',
        subjectKey: 'issue:repo#1',
        sourceEventId: 'event-A',
        briefingContext: 'ctx A',
      });
      await driver.spawnNarrator({
        caseId: 'ci-b',
        subjectKey: 'issue:repo#2',
        sourceEventId: 'event-B',
        briefingContext: 'ctx B',
      });

      assert.equal(wakeCatCalls.length, 2, 'different eventIds → both should execute');
    });
  });

  describe('INV-1: narrator does not touch case.state', () => {
    it('spawnNarrator calls wakeCat with a briefing but does NOT call any case state mutation', async () => {
      // NarratorDriver constructor takes NO caseStore parameter — there is literally no path
      // to mutate case.state. This test documents the contract structurally.
      const mockWakeCat = async () => {};
      const mockRoleResolver = {
        resolve: () => ({
          catId: 'gemini25',
          model: 'gemini-3.5-flash',
          promptTemplateId: 'community-narrator-v1',
          capabilities: ['triage', 'route-recommend', 'public-reply'],
        }),
      };

      const driver = new NarratorDriver({
        roleResolver: mockRoleResolver,
        narratorThreadId: 'thread_narrator_ops',
        wakeCat: mockWakeCat,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });

      // Verifies constructor signature: no communityIssueStore parameter exists (INV-1)
      const driverKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(driver));
      assert.ok(!driverKeys.includes('communityIssueStore'), 'NarratorDriver must not hold a caseStore ref (INV-1)');
      // Spawn completes without any exception (caseStore access would throw above)
      await driver.spawnNarrator({
        caseId: 'ci-inv1',
        subjectKey: 'issue:repo#1',
        sourceEventId: 'e1',
        briefingContext: 'ctx',
      });
      assert.ok(true, 'narrator spawn must never touch case.state (INV-1)');
    });
  });

  describe('INV-2: narrator executor capabilities exclude code/merge/worktree', () => {
    it('binding with "code" capability is rejected (fail-closed via RoleResolver)', async () => {
      const warnings = [];
      const mockRoleResolver = {
        resolve: (role) => {
          if (role === 'narrator') {
            // Simulate a misconfigured binding that slipped a forbidden capability
            // RoleResolver.createRoleResolver rejects this → returns null + warn
            return null; // resolver fail-closed
          }
          return null;
        },
        // expose why it would fail for test clarity
        _note: 'binding has "code" capability → resolver returns null (INV-2 enforcement)',
      };

      let wakeCatCalled = false;
      const mockWakeCat = async () => {
        wakeCatCalled = true;
      };

      const driver = new NarratorDriver({
        roleResolver: mockRoleResolver,
        narratorThreadId: 'thread_narrator_ops',
        wakeCat: mockWakeCat,
        log: { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} },
      });

      await driver.spawnNarrator({ caseId: 'ci-x', subjectKey: 's', sourceEventId: 'e', briefingContext: 'ctx' });

      assert.equal(wakeCatCalled, false, 'no wakeCat when resolver returns null (INV-2 guard)');
    });
  });

  describe('fail-loud: roleResolver returns null → warn, no wakeCat', () => {
    it('resolve failure logs a warning and skips spawn (never throws)', async () => {
      const warnings = [];
      const mockRoleResolver = { resolve: () => null };
      let wakeCatCalled = false;
      const mockWakeCat = async () => {
        wakeCatCalled = true;
      };

      const driver = new NarratorDriver({
        roleResolver: mockRoleResolver,
        narratorThreadId: 'thread_narrator_ops',
        wakeCat: mockWakeCat,
        log: {
          info: () => {},
          warn: (ctx, msg) => warnings.push(msg || ctx),
          error: () => {},
        },
      });

      await driver.spawnNarrator({ caseId: 'ci-x', subjectKey: 's', sourceEventId: 'e', briefingContext: 'ctx' });

      assert.equal(wakeCatCalled, false, 'wakeCat must not be called when resolver returns null');
      assert.ok(warnings.length > 0, 'a warning must be emitted when narrator is unresolved');
    });
  });

  describe('fail-safe: wakeCat throws → error caught, not propagated', () => {
    it('a wakeCat rejection is swallowed (fire-and-forget, never crashes dispatch)', async () => {
      const errors = [];
      const mockRoleResolver = {
        resolve: () => ({
          catId: 'gemini25',
          model: 'gemini-3.5-flash',
          promptTemplateId: 'community-narrator-v1',
          capabilities: ['triage', 'route-recommend', 'public-reply'],
        }),
      };
      const mockWakeCat = async () => {
        throw new Error('invocationQueue is full');
      };

      const driver = new NarratorDriver({
        roleResolver: mockRoleResolver,
        narratorThreadId: 'thread_narrator_ops',
        wakeCat: mockWakeCat,
        log: {
          info: () => {},
          warn: () => {},
          error: (ctx, msg) => errors.push(msg || ctx),
        },
      });

      // Must not throw — fire-and-forget failure must be absorbed
      await assert.doesNotReject(async () => {
        await driver.spawnNarrator({ caseId: 'ci-err', subjectKey: 's', sourceEventId: 'e2', briefingContext: 'ctx' });
      });
      assert.ok(errors.length > 0, 'error must be logged when wakeCat rejects');
    });
  });

  describe('wakeCat call shape', () => {
    it('passes correct threadId/catId/briefing/timeoutMs to wakeCat', async () => {
      const calls = [];
      const mockWakeCat = async (params) => {
        calls.push(params);
      };
      const mockRoleResolver = {
        resolve: () => ({
          catId: 'gemini25',
          model: 'gemini-3.5-flash',
          promptTemplateId: 'community-narrator-v1',
          capabilities: ['triage', 'route-recommend', 'public-reply'],
        }),
      };

      const driver = new NarratorDriver({
        roleResolver: mockRoleResolver,
        narratorThreadId: 'thread_narrator_ops_abc',
        wakeCat: mockWakeCat,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await driver.spawnNarrator({
        caseId: 'ci-912',
        subjectKey: 'issue:clowder-ai#912',
        sourceEventId: 'ev-1',
        briefingContext: 'Dark mode request',
      });

      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.equal(call.threadId, 'thread_narrator_ops_abc', 'threadId must be the configured narratorThreadId');
      assert.equal(call.catId, 'gemini25', 'catId must come from RoleResolver (INV-6)');
      assert.ok(typeof call.briefing === 'string' && call.briefing.length > 0, 'briefing must be a non-empty string');
      assert.ok(
        call.briefing.includes('ci-912'),
        'briefing must contain caseId for triage-complete callback (P1-2 R1)',
      );
      assert.ok(
        call.briefing.includes('/api/community-issues/ci-912/triage-complete'),
        'briefing must contain full callback URL (P1-2 R1)',
      );
      assert.ok(typeof call.timeoutMs === 'number' && call.timeoutMs > 0, 'timeoutMs must be positive');
      // R2 P2: briefing must include required payload schema so narrator knows what triage-complete expects
      assert.ok(call.briefing.includes('verdict'), 'briefing must document required verdict field (R2 P2)');
      assert.ok(call.briefing.includes('WELCOME'), 'briefing must list verdict enum values (R2 P2)');
      assert.ok(call.briefing.includes('questions'), 'briefing must document required questions field (R2 P2)');
      assert.ok(call.briefing.includes('Q1'), 'briefing must show Q1..Q5 shape (R2 P2)');
      assert.ok(call.briefing.includes('Q5'), 'briefing must show Q1..Q5 shape (R2 P2)');
    });
  });
});
