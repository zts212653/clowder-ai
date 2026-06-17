import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computePackChecksum,
  GOVERNANCE_PACK_VERSION,
  getGovernanceManagedBlock,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
} from '../../dist/config/governance/governance-pack.js';

const expectedFrontendPort = process.env.FRONTEND_PORT ?? '3003';
const expectedApiPort = process.env.API_SERVER_PORT ?? '3004';
const expectedRuntimePortsText = `frontend ${expectedFrontendPort} and API ${expectedApiPort}`;

describe('governance-pack', () => {
  it('managed block has start/end markers', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes(MANAGED_BLOCK_START));
    assert.ok(block.includes(MANAGED_BLOCK_END));
  });

  it('contains internal port 3003 (transformed by sync pipeline for open-source)', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes(expectedFrontendPort), `Source should use frontend port ${expectedFrontendPort}`);
  });

  it('contains internal port 6399 (transformed by sync pipeline for open-source)', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('6399'), 'Source should use internal port 6399');
  });

  it('public local defaults guidance is present', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('Public local defaults'), 'Port defaults guidance should be present');
    assert.ok(block.includes('production Redis'), 'Redis port guidance should be present');
  });

  it('self context keeps Clowder AI runtime defaults wording', () => {
    const block = getGovernanceManagedBlock('claude', 'self');
    assert.ok(block.includes('Public local defaults'), 'self context should describe Clowder AI local defaults');
    assert.ok(block.includes(`use ${expectedRuntimePortsText}`), 'self context should keep runtime usage wording');
    assert.ok(
      !block.includes('Avoid using these ports for this project'),
      'self context should not use avoidance wording',
    );
  });

  it('external context reserves Clowder AI runtime ports instead of telling projects to use them', () => {
    const block = getGovernanceManagedBlock('claude', 'external');
    assert.ok(block.includes('Clowder AI runtime ports'), 'external context should name Clowder AI runtime ports');
    assert.ok(block.includes(`${expectedRuntimePortsText} are reserved by Clowder AI`));
    assert.ok(block.includes("Avoid using these ports for this project's dev servers."));
    assert.ok(
      !block.includes('Public local defaults'),
      'external context should not advertise Clowder AI ports as defaults',
    );
    assert.ok(
      !block.includes(`use ${expectedRuntimePortsText}`),
      'external context must not instruct projects to use Clowder AI ports',
    );
  });

  it('managed block includes governance rules from shared-rules', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('self-review'), 'Should include no-self-review rule');
    assert.ok(block.includes('Identity'), 'Should include identity constraint');
  });

  it('managed block includes methodology intro', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('frontmatter'));
    assert.ok(block.includes('Feature lifecycle'));
    assert.ok(block.includes('SOP'));
  });

  it('includes pack version', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes(GOVERNANCE_PACK_VERSION));
  });

  it('includes provider name', () => {
    assert.ok(getGovernanceManagedBlock('claude').includes('claude'));
    assert.ok(getGovernanceManagedBlock('codex').includes('codex'));
    assert.ok(getGovernanceManagedBlock('gemini').includes('gemini'));
    assert.ok(getGovernanceManagedBlock('kimi').includes('kimi'));
  });

  it('pack version is semver', () => {
    assert.match(GOVERNANCE_PACK_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('checksum is stable for same content', () => {
    const a = computePackChecksum();
    const b = computePackChecksum();
    assert.strictEqual(a, b);
  });

  it('checksum differs between self and external managed block contexts', () => {
    assert.notEqual(computePackChecksum('self'), computePackChecksum('external'));
  });

  it('checksum is a 12-char hex string', () => {
    const checksum = computePackChecksum();
    assert.match(checksum, /^[0-9a-f]{12}$/);
  });

  it('collaboration standards reference shared-rules and skills', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('shared-rules.md'));
    assert.ok(block.includes('cat-cafe-skills'));
  });

  it('pack version is 1.4.1', () => {
    assert.equal(GOVERNANCE_PACK_VERSION, '1.4.1');
  });
});
