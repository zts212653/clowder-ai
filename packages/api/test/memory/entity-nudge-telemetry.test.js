/**
 * F260 Phase B AC-B5: Entity nudge telemetry instruments.
 *
 * Verifies the OTel counters exist and are callable.
 * The actual increment happens in the nudge delivery path (route-serial.ts),
 * which is integration-tested separately.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F260 entity nudge telemetry instruments (AC-B5)', () => {
  it('exports entityNudgeDetected counter', async () => {
    const { entityNudgeDetected } = await import('../../dist/infrastructure/telemetry/instruments.js');
    assert.ok(entityNudgeDetected, 'entityNudgeDetected should be exported');
    assert.equal(typeof entityNudgeDetected.add, 'function');
  });

  it('exports entityNudgeDelivered counter', async () => {
    const { entityNudgeDelivered } = await import('../../dist/infrastructure/telemetry/instruments.js');
    assert.ok(entityNudgeDelivered, 'entityNudgeDelivered should be exported');
    assert.equal(typeof entityNudgeDelivered.add, 'function');
  });

  it('exports entityNudgeSuppressed counter', async () => {
    const { entityNudgeSuppressed } = await import('../../dist/infrastructure/telemetry/instruments.js');
    assert.ok(entityNudgeSuppressed, 'entityNudgeSuppressed should be exported');
    assert.equal(typeof entityNudgeSuppressed.add, 'function');
  });

  it('exports entityNudgePrivacyBlocked counter', async () => {
    const { entityNudgePrivacyBlocked } = await import('../../dist/infrastructure/telemetry/instruments.js');
    assert.ok(entityNudgePrivacyBlocked, 'entityNudgePrivacyBlocked should be exported');
    assert.equal(typeof entityNudgePrivacyBlocked.add, 'function');
  });

  it('all counters accept attributes (sourceFamily, aliasClass)', async () => {
    const { entityNudgeDetected, entityNudgeDelivered } = await import(
      '../../dist/infrastructure/telemetry/instruments.js'
    );

    // Should not throw when called with attributes
    assert.doesNotThrow(() => {
      entityNudgeDetected.add(1, { sourceFamily: 'entity_registry', aliasClass: 'concept' });
      entityNudgeDelivered.add(1, { sourceFamily: 'doc_aliases', aliasClass: 'doc' });
    });
  });
});
