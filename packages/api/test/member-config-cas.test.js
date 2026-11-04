import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { configStore } from '../dist/config/ConfigStore.js';

describe('client setting owner compare-and-set', () => {
  afterEach(() => configStore.reset());

  it('rejects a stale editor without changing the adopted setting', () => {
    configStore.set('cli.codexSandboxMode', 'workspace-write');
    assert.throws(
      () => configStore.set('cli.codexSandboxMode', 'danger-full-access', 'obsolete-revision'),
      /revision|其他页面/,
    );
    assert.equal(configStore.get('cli.codexSandboxMode'), 'workspace-write');
  });

  it('uses a resource revision so another setting does not conflict', () => {
    const revision = configStore.revision('cli.codexSandboxMode');
    configStore.set('cli.codexApprovalPolicy', 'on-request');
    configStore.set('cli.codexSandboxMode', 'workspace-write', revision);
    assert.equal(configStore.get('cli.codexSandboxMode'), 'workspace-write');
    assert.notEqual(configStore.revision('cli.codexSandboxMode'), revision);
  });

  it('keeps revisions stable for a retry of the same saved value', () => {
    configStore.set('cli.codexSandboxMode', 'read-only');
    const revision = configStore.revision('cli.codexSandboxMode');
    configStore.set('cli.codexSandboxMode', 'read-only', revision);
    assert.equal(configStore.revision('cli.codexSandboxMode'), revision);
  });
});
