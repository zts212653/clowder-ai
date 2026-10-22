import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { allowsAcpBootstrapConfigAuditWarning } from '../../src/config/acp-bootstrap-config-audit-policy.js';
import { reportAcpHostPolicy, resolveAcpHostPolicy } from '../../src/config/acp-host-policy.js';
import { ENV_VARS } from '../../src/config/env-registry.js';
import { isTrustedHostCompatibilityEnabled } from '../../src/config/trusted-host-compatibility.js';
import { inspectAcpBootstrapDirectory } from '../../src/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';

const keys = [
  'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
  'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
  'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY',
];
let original: Record<string, string | undefined>;
beforeEach(() => {
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
});
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

test('persistent legacy exact-one opt-in maps only to the Windows root-only policy, with explicit new keys winning', () => {
  for (const old of [undefined, '', '0', 'true', '01', '1']) {
    for (const bootstrap of [undefined, 'strict', 'trusted-host']) {
      for (const audit of [undefined, 'required', 'warn-bootstrap-root']) {
        const values = [bootstrap, audit, old];
        keys.forEach((key, i) => {
          if (values[i] === undefined) delete process.env[key];
          else process.env[key] = values[i];
        });
        const trusted = bootstrap === 'trusted-host' || (bootstrap === undefined && old === '1');
        const warning = audit === 'warn-bootstrap-root' || (audit === undefined && old === '1');
        assert.equal(isTrustedHostCompatibilityEnabled(), trusted);
        assert.equal(
          allowsAcpBootstrapConfigAuditWarning(),
          process.platform === 'win32' && trusted && warning,
          JSON.stringify(values),
        );
      }
    }
  }
});

test('invalid explicit values fail at startup and never fall back to legacy; direct inspector stays readable', () => {
  for (const key of keys.slice(0, 2))
    for (const value of ['', 'typo', 'STRICT']) {
      assert.throws(
        () => resolveAcpHostPolicy({ [key]: value, CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: '1' }),
        new RegExp(key),
      );
    }
  if (process.platform === 'win32') {
    process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'typo';
    const result = inspectAcpBootstrapDirectory();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE/);
  }
});

test('startup reports requested versus effective policy, including strict masking the legacy warning', () => {
  const entries: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => entries.push({ level: 'info', fields, message }),
    warn: (fields: Record<string, unknown>, message: string) => entries.push({ level: 'warn', fields, message }),
  };
  reportAcpHostPolicy(
    logger,
    resolveAcpHostPolicy(
      { CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: '1', CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE: 'strict' },
      'win32',
    ),
  );
  assert.equal(entries.filter((entry) => entry.level === 'warn').length, 1);
  assert.equal(entries[0]?.fields.requestedAuditMode, 'warn-bootstrap-root');
  assert.equal(entries[0]?.fields.effectiveAuditMode, 'required');
  assert.match(String(entries[0]?.fields.suppressedReason), /strict/);
  assert.equal(resolveAcpHostPolicy({ CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: '1' }, 'darwin').auditWarningAllowed, false);
});

test('both policies declare their only allowed values and remain restart-only', () => {
  for (const [name, values] of [
    [keys[0], ['strict', 'trusted-host']],
    [keys[1], ['required', 'warn-bootstrap-root']],
  ] as const) {
    const definition = ENV_VARS.find((entry) => entry.name === name);
    assert.deepEqual(definition?.allowedValues, values);
    assert.equal(definition?.runtimeEditable, false);
    assert.equal(definition?.restartRequired, true);
  }
});
