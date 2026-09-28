import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { hasUsableAgentKeyCredentials } from '@cat-cafe/shared/utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AGENT_KEY_TOOLS,
  buildLimbTools,
  parseToolsetEnv,
  READONLY_ALLOWED_TOOLS,
  registerFullToolset,
  type ToolsetEnv,
} from '../src/server-toolsets.js';
import { getCallbackConfig } from '../src/tools/callback-tools.js';

/**
 * #1494 formal-review regressions:
 *  - P1-2: agent-key availability is credential USABILITY (mirrors the
 *    callback auth resolution semantics), not env-var presence. A `'{}'`
 *    variant map, bad JSON, an empty secret, or a path to a missing sidecar
 *    must all count as "no credentials" for the readonly+agent-key union.
 *  - P2: registerFullToolset must honor the injected ToolsetEnv end to end
 *    (parse once) — an invalid ambient CAT_CAFE_MCP_PROFILE must not throw
 *    when an explicit env was provided.
 */

let tmpDir: string | undefined;

function sidecar(content = 'agent-key-material'): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'agent-key-usability-test-'));
  const filePath = join(tmpDir, `key-${Math.random().toString(36).slice(2)}.secret`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function registeredNames(env?: ToolsetEnv): Set<string> {
  const server = new McpServer({ name: 'agent-key-usability-test', version: '0.0.1' });
  registerFullToolset(server, env);
  const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return new Set(Object.keys(registry));
}

// limb family is deliberately unfiltered by readonly (F061 antigravity contract).
function limbNames(env?: ToolsetEnv): string[] {
  return buildLimbTools(env).map((tool) => tool.name);
}

function strictExpected(env?: ToolsetEnv): Set<string> {
  return new Set([...READONLY_ALLOWED_TOOLS, ...limbNames(env)]);
}

describe('parseToolsetEnv — hasAgentKey is credential usability, not env presence', () => {
  it('SECRET: non-blank usable, empty/whitespace-only rejected (round-3 restore)', () => {
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_SECRET: 'material' }).hasAgentKey, true);
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_SECRET: '' }).hasAgentKey, false);
    // #1494 round 3: a whitespace-only secret is no material — HTTP header
    // transport normalizes it to an empty value, so it must not count.
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_SECRET: '   ' }).hasAgentKey, false);
  });

  it('single FILE counts only when the sidecar exists and reads non-empty', () => {
    const filePath = sidecar();
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILE: filePath }).hasAgentKey, true);
    assert.equal(
      parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILE: '/nonexistent/agent-key.secret' }).hasAgentKey,
      false,
      'a path to a missing sidecar is not a credential',
    );
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILE: '   ' }).hasAgentKey, false);
  });

  it('variant map: {} / bad JSON / all-missing sidecars → no credentials', () => {
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILES: '{}' }).hasAgentKey, false);
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILES: 'not-json' }).hasAgentKey, false);
    assert.equal(
      parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILES: '{"a":"/nonexistent/agent-key.secret"}' }).hasAgentKey,
      false,
    );
  });

  it('variant map with at least one readable sidecar → credentials', () => {
    const filePath = sidecar();
    const env = { CAT_CAFE_AGENT_KEY_FILES: `{"a":"/nonexistent/x.secret","antigravity":"${filePath}"}` };
    assert.equal(parseToolsetEnv(env).hasAgentKey, true);
  });

  it('non-empty FILES disables fallback: {} map + ambient SECRET → no credentials', () => {
    const env = { CAT_CAFE_AGENT_KEY_FILES: '{}', CAT_CAFE_AGENT_KEY_SECRET: 'material' };
    assert.equal(
      parseToolsetEnv(env).hasAgentKey,
      false,
      'a present variant map is the only source; SECRET/FILE fallback is disabled',
    );
  });

  it('bound identity gates hasAgentKey: only its own map entry qualifies (#1494 round 2)', () => {
    const antigravityPath = sidecar();
    const gptProPath = sidecar();
    assert.equal(
      parseToolsetEnv({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: antigravityPath }),
      }).hasAgentKey,
      false,
      'an unrelated readable key must not qualify for a bound identity',
    );
    assert.equal(
      parseToolsetEnv({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: antigravityPath, 'gpt-pro': gptProPath }),
      }).hasAgentKey,
      true,
    );
    assert.equal(
      parseToolsetEnv({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_SECRET: 'unbound-secret',
      }).hasAgentKey,
      false,
      'a bound identity resolves only through its variant-map entry',
    );
  });
});

describe('availability parity with the real callback resolver (#1494 round 2)', () => {
  const ENV_KEYS = [
    'CAT_CAFE_AGENT_KEY_SECRET',
    'CAT_CAFE_AGENT_KEY_FILE',
    'CAT_CAFE_AGENT_KEY_FILES',
    'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
  ] as const;
  let saved: Record<string, string | undefined>;
  let savedApiUrl: string | undefined;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    savedApiUrl = process.env.CAT_CAFE_API_URL;
    process.env.CAT_CAFE_API_URL = 'http://localhost:3004';
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (savedApiUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = savedApiUrl;
  });

  /** Replace the credential env wholesale for one row. */
  function setCredentialEnv(env: Record<string, string>): void {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
  }

  it('bound identity + unrelated readable map entry: helper and resolver both say unusable', () => {
    const antigravityPath = sidecar();
    setCredentialEnv({
      CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
      CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: antigravityPath }),
    });
    assert.equal(hasUsableAgentKeyCredentials(process.env), false, 'helper: bound entry missing');
    assert.equal(getCallbackConfig({ forceAgentKey: true }), null, 'resolver (no selection)');
    assert.equal(getCallbackConfig({ forceAgentKey: true, agentKeyCatId: 'gpt-pro' }), null, 'resolver (bound id)');
    assert.equal(
      getCallbackConfig({ forceAgentKey: true, agentKeyCatId: 'antigravity' }),
      null,
      'resolver (mismatched selection)',
    );
  });

  it('bound identity + its own readable entry: helper and resolver both say usable', () => {
    const gptProPath = sidecar();
    setCredentialEnv({
      CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
      CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ 'gpt-pro': gptProPath }),
    });
    assert.equal(hasUsableAgentKeyCredentials(process.env), true);
    assert.notEqual(getCallbackConfig({ forceAgentKey: true }), null);
    assert.notEqual(getCallbackConfig({ forceAgentKey: true, agentKeyCatId: 'gpt-pro' }), null);
  });

  it('bound identity with only an unbound SECRET: helper and resolver both say unusable', () => {
    setCredentialEnv({
      CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
      CAT_CAFE_AGENT_KEY_SECRET: 'unbound-secret',
    });
    assert.equal(hasUsableAgentKeyCredentials(process.env), false);
    assert.equal(getCallbackConfig({ forceAgentKey: true }), null);
  });

  it('padded single-FILE path is read literally: helper and resolver both say unusable', () => {
    const filePath = sidecar();
    setCredentialEnv({ CAT_CAFE_AGENT_KEY_FILE: ` ${filePath} ` });
    assert.equal(hasUsableAgentKeyCredentials(process.env), false);
    assert.equal(getCallbackConfig({ forceAgentKey: true }), null);
  });

  it('unbound single FILE / SECRET: helper and resolver both say usable', () => {
    const filePath = sidecar();
    setCredentialEnv({ CAT_CAFE_AGENT_KEY_FILE: filePath });
    assert.equal(hasUsableAgentKeyCredentials(process.env), true);
    assert.notEqual(getCallbackConfig({ forceAgentKey: true }), null);

    setCredentialEnv({ CAT_CAFE_AGENT_KEY_SECRET: 'material' });
    assert.equal(hasUsableAgentKeyCredentials(process.env), true);
    assert.notEqual(getCallbackConfig({ forceAgentKey: true }), null);
  });

  it('blank SECRET: helper and resolver both say unusable (#1494 round 3)', () => {
    setCredentialEnv({ CAT_CAFE_AGENT_KEY_SECRET: '   ' });
    assert.equal(hasUsableAgentKeyCredentials(process.env), false);
    assert.equal(getCallbackConfig({ forceAgentKey: true }), null);
  });

  it('unbound shared map: mount-level resolver stays null, but a selectable identity resolves — helper says usable', () => {
    const antigravityPath = sidecar();
    setCredentialEnv({ CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: antigravityPath }) });
    assert.equal(
      getCallbackConfig({ forceAgentKey: true }),
      null,
      'no identity selected at mount level — the resolver intentionally resolves nothing',
    );
    assert.notEqual(
      getCallbackConfig({ forceAgentKey: true, agentKeyCatId: 'antigravity' }),
      null,
      'per-call identity selection resolves the shared map',
    );
    assert.equal(
      hasUsableAgentKeyCredentials(process.env),
      true,
      'availability counts a selectable identity (maintainer-approved positive)',
    );
  });
});

describe('mount surface — maintainer acceptance baseline (#1494)', () => {
  it('strict ambient-secret mount (no opt-in) → exactly READONLY ∪ limb', () => {
    const env = parseToolsetEnv({ CAT_CAFE_READONLY: 'true', CAT_CAFE_AGENT_KEY_SECRET: 'ambient-secret' });
    const names = registeredNames(env);
    assert.deepEqual([...names].sort(), [...strictExpected(env)].sort());
    assert.equal(names.has('cat_cafe_cross_post_message'), false, 'write tool must stay out without opt-in');
  });

  it('explicit opt-in with a usable sidecar → READONLY ∪ AGENT_KEY ∪ limb', () => {
    const env = parseToolsetEnv({
      CAT_CAFE_READONLY: 'true',
      CAT_CAFE_READONLY_AGENT_KEY_UNION: 'true',
      CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: sidecar() }),
    });
    const names = registeredNames(env);
    const expected = new Set([...READONLY_ALLOWED_TOOLS, ...AGENT_KEY_TOOLS, ...limbNames(env)]);
    assert.deepEqual([...names].sort(), [...expected].sort());
    assert.equal(names.has('cat_cafe_cross_post_message'), true, 'legit opt-in keeps the union');
  });

  it('explicit opt-in + FILES="{}" → strict surface (no fallback to ambient creds)', () => {
    const env = parseToolsetEnv({
      CAT_CAFE_READONLY: 'true',
      CAT_CAFE_READONLY_AGENT_KEY_UNION: 'true',
      CAT_CAFE_AGENT_KEY_FILES: '{}',
      CAT_CAFE_AGENT_KEY_SECRET: 'ambient-secret',
    });
    const names = registeredNames(env);
    assert.deepEqual([...names].sort(), [...strictExpected(env)].sort());
    assert.equal(
      names.has('cat_cafe_cross_post_message'),
      false,
      'an empty variant map yields zero resolvable keys — the union must not fire',
    );
  });
});

describe('parse-once threading (#1494 P2)', () => {
  it('registerFullToolset with an injected env never re-reads ambient process.env', () => {
    const original = process.env.CAT_CAFE_MCP_PROFILE;
    process.env.CAT_CAFE_MCP_PROFILE = 'bogus-profile';
    try {
      const names = registeredNames({ readonly: true });
      assert.deepEqual([...names].sort(), [...strictExpected({ readonly: true })].sort());
    } finally {
      if (original === undefined) delete process.env.CAT_CAFE_MCP_PROFILE;
      else process.env.CAT_CAFE_MCP_PROFILE = original;
    }
  });
});
