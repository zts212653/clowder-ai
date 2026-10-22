// Plugin agent-provider declarations reject unsupported fields and package code.
//
// The declaration is the only thing a plugin is allowed to say about its agent,
// so the parser is the security boundary: unknown keys are refused rather than
// ignored, only the ACP transport is allowed, and no declared command or
// argument may point at a file inside the plugin package (the plugin must not be
// able to run its own code with Host privileges).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  AGENT_PROVIDER_DECLARATION_FILE,
  parseAgentProviderDeclaration,
} from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';

const PACKAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-provider-pkg-'));

function parse(raw, packageRoot = PACKAGE_ROOT) {
  return parseAgentProviderDeclaration(raw, { packageRoot });
}

function valid(overrides = {}, acpOverrides = {}) {
  return {
    id: 'intranet-agent',
    transport: 'acp',
    acp: { command: 'node', startupArgs: [], ...acpOverrides },
    ...overrides,
  };
}

function assertRejected(result, code) {
  assert.equal(result.ok, false, `expected a rejection, got ${JSON.stringify(result)}`);
  assert.equal(result.code, code);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'a rejection must explain itself');
  assert.equal(result.declaration, undefined, 'a rejection must not smuggle a declaration out');
}

test('[35] the declaration file name is agent-provider.json', () => {
  assert.equal(AGENT_PROVIDER_DECLARATION_FILE, 'agent-provider.json');
});

test('[35] a value that is not a plain object is an invalid declaration', () => {
  for (const raw of [null, undefined, 'agent-provider.json', 42, true, [], () => {}]) {
    assertRejected(parse(raw), 'invalid_declaration');
  }
});

test('[35] unknown top-level keys are refused, not ignored', () => {
  for (const key of ['entrypoint', 'factory', 'module', 'displayHint', 'runtime']) {
    assertRejected(parse({ ...valid(), [key]: 'x' }), 'invalid_declaration');
  }
});

test('[35] the id must match ^[a-z0-9][a-z0-9._-]{0,63}$', () => {
  for (const id of ['', 'Agent', '-agent', '.agent', 'a b', 'agent/one', 'a'.repeat(65), 42, null]) {
    assertRejected(parse({ ...valid(), id }), 'invalid_declaration');
  }

  for (const id of ['a', 'agent-1', 'a.b_c-d', '9bot', 'a'.repeat(64)]) {
    assert.equal(parse({ ...valid(), id }).ok, true, `id ${id} should be accepted`);
    assert.equal(parse({ ...valid(), id }).declaration.id, id);
  }
});

test('[35] a non-string transport is invalid; a string other than acp is transport_not_allowed', () => {
  assertRejected(parse({ ...valid(), transport: 42 }), 'invalid_declaration');
  assertRejected(parse({ ...valid(), transport: undefined }), 'invalid_declaration');

  for (const transport of ['a2a', 'ACP', 'http', '']) {
    assertRejected(parse({ ...valid(), transport }), 'transport_not_allowed');
  }
});

test('[35] the acp block is a plain object with only command, startupArgs and mcpWhitelist', () => {
  assertRejected(parse({ ...valid(), acp: undefined }), 'invalid_declaration');
  assertRejected(parse({ ...valid(), acp: null }), 'invalid_declaration');
  assertRejected(parse({ ...valid(), acp: 'node' }), 'invalid_declaration');
  assertRejected(parse({ ...valid(), acp: [] }), 'invalid_declaration');
  assertRejected(parse({ ...valid(), acp: { command: 'node', startupArgs: [], cwd: '/tmp' } }), 'invalid_declaration');
  assertRejected(
    parse({ ...valid(), acp: { command: 'node', startupArgs: [], env: { TOKEN: 'x' } } }),
    'invalid_declaration',
  );
});

test('[35] command must be a non-empty string', () => {
  assertRejected(parse(valid({}, { command: '' })), 'invalid_declaration');
  assertRejected(parse(valid({}, { command: 42 })), 'invalid_declaration');
  assertRejected(parse({ ...valid(), acp: { startupArgs: [] } }), 'invalid_declaration');
});

test('[35] startupArgs is required and must be an array of strings', () => {
  assertRejected(parse({ ...valid(), acp: { command: 'node' } }), 'invalid_declaration');
  assertRejected(parse(valid({}, { startupArgs: 'server.mjs' })), 'invalid_declaration');
  assertRejected(parse(valid({}, { startupArgs: [1] })), 'invalid_declaration');
  assertRejected(parse(valid({}, { startupArgs: [null] })), 'invalid_declaration');
  assertRejected(parse(valid({}, { startupArgs: {} })), 'invalid_declaration');
  assert.equal(parse(valid({}, { startupArgs: [] })).ok, true);
  assert.equal(parse(valid({}, { startupArgs: ['serve', '--stdio'] })).ok, true);
});

test('[35] mcpWhitelist is optional but must be an array of strings when present', () => {
  assertRejected(parse(valid({}, { mcpWhitelist: 'github' })), 'invalid_declaration');
  assertRejected(parse(valid({}, { mcpWhitelist: [1] })), 'invalid_declaration');
  assertRejected(parse(valid({}, { mcpWhitelist: {} })), 'invalid_declaration');
  assert.equal(parse(valid({}, { mcpWhitelist: [] })).ok, true);
  assert.equal(parse(valid({}, { mcpWhitelist: ['github'] })).ok, true);
});

test('[35] a command pointing inside the plugin package is package_command_forbidden', () => {
  assertRejected(parse(valid({}, { command: path.join(PACKAGE_ROOT, 'bin', 'agent') })), 'package_command_forbidden');
  assertRejected(parse(valid({}, { command: path.join(PACKAGE_ROOT, 'agent') })), 'package_command_forbidden');
  assertRejected(parse(valid({}, { command: './bin/agent' })), 'package_command_forbidden');
  assertRejected(parse(valid({}, { command: 'bin/agent' })), 'package_command_forbidden');
  assertRejected(parse(valid({}, { command: 'node_modules/.bin/agent' })), 'package_command_forbidden');
});

test('[35] a startup argument pointing inside the plugin package is package_command_forbidden', () => {
  assertRejected(
    parse(valid({}, { startupArgs: [path.join(PACKAGE_ROOT, 'fake-acp-agent.mjs')] })),
    'package_command_forbidden',
  );
  assertRejected(
    parse(valid({}, { startupArgs: ['--stdio', path.join(PACKAGE_ROOT, 'nested', 'agent.mjs')] })),
    'package_command_forbidden',
  );
});

test('[35] a bare command, an outside absolute path and outside arguments are allowed', () => {
  const bare = parse(valid({}, { command: 'node', startupArgs: ['serve'] }));
  assert.equal(bare.ok, true);

  const absolute = parse(
    valid({}, { command: '/usr/local/bin/intranet-agent', startupArgs: ['/opt/intranet/server.mjs'] }),
  );
  assert.equal(absolute.ok, true);
  assert.equal(absolute.declaration.acp.command, '/usr/local/bin/intranet-agent');
  assert.deepEqual(absolute.declaration.acp.startupArgs, ['/opt/intranet/server.mjs']);

  // The rule is about the resolved path, not about the string prefix.
  const escaped = parse(valid({}, { command: `${PACKAGE_ROOT}/../outside-agent` }));
  assert.equal(escaped.ok, true, 'a path that resolves outside the package is allowed');
});

test('[35] a successful parse returns only the declared fields', () => {
  const result = parse({
    id: 'intranet-agent',
    transport: 'acp',
    acp: { command: 'node', startupArgs: ['serve'], mcpWhitelist: ['github'] },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.declaration, {
    id: 'intranet-agent',
    transport: 'acp',
    acp: { command: 'node', startupArgs: ['serve'], mcpWhitelist: ['github'] },
  });
  assert.deepEqual(Object.keys(result.declaration).sort(), ['acp', 'id', 'transport']);
});

test('[35] a declaration without mcpWhitelist does not invent extra fields', () => {
  const result = parse(valid());

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.declaration).sort(), ['acp', 'id', 'transport']);
  for (const key of Object.keys(result.declaration.acp)) {
    assert.ok(['command', 'startupArgs', 'mcpWhitelist'].includes(key), `unexpected acp key ${key}`);
  }
  assert.deepEqual(result.declaration.acp.command, 'node');
  assert.deepEqual(result.declaration.acp.startupArgs, []);
});
