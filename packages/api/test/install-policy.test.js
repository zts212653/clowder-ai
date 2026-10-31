import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateInstallPolicy } from '../dist/config/capabilities/install-policy.js';

describe('InstallPolicyEngine', () => {
  test('allows official trust level by default', () => {
    const result = evaluateInstallPolicy({ trustLevel: 'official' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, undefined);
  });

  test('allows verified trust level by default', () => {
    const result = evaluateInstallPolicy({ trustLevel: 'verified' });
    assert.strictEqual(result.allowed, true);
  });

  test('blocks community trust level by default', () => {
    const result = evaluateInstallPolicy({ trustLevel: 'community' });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'community_requires_confirmation');
  });

  test('allows community when explicitly confirmed', () => {
    const result = evaluateInstallPolicy({
      trustLevel: 'community',
      userConfirmed: true,
    });
    assert.strictEqual(result.allowed, true);
  });

  test('blocks install with scripts by default', () => {
    const result = evaluateInstallPolicy({
      trustLevel: 'official',
      hasInstallScripts: true,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'install_scripts_denied');
  });

  test('allows scripts when explicitly approved', () => {
    const result = evaluateInstallPolicy({
      trustLevel: 'official',
      hasInstallScripts: true,
      scriptsApproved: true,
    });
    assert.strictEqual(result.allowed, true);
  });

  test('community + scripts requires both confirmations', () => {
    const result = evaluateInstallPolicy({
      trustLevel: 'community',
      hasInstallScripts: true,
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.requiredConfirmations.length === 2);
  });

  test('community + scripts with only user confirm still blocked by scripts', () => {
    const result = evaluateInstallPolicy({
      trustLevel: 'community',
      hasInstallScripts: true,
      userConfirmed: true,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'install_scripts_denied');
  });

  test('custom policy can allow community auto-install', () => {
    const result = evaluateInstallPolicy(
      { trustLevel: 'community' },
      {
        autoInstallTrustLevels: ['official', 'verified', 'community'],
        denyInstallScripts: true,
        requireProbeBeforeReady: true,
      },
    );
    assert.strictEqual(result.allowed, true);
  });

  test('missing trustLevel is fail-closed (requires confirmation)', () => {
    const result = evaluateInstallPolicy({});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'community_requires_confirmation');
  });

  test('missing trustLevel with user confirmation passes', () => {
    const result = evaluateInstallPolicy({ userConfirmed: true });
    assert.strictEqual(result.allowed, true);
  });
});
