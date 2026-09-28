import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentKeyFileUsable,
  hasUsableAgentKeyCredentials,
  parseAgentKeyFileMap,
  readAgentKeyFileSync,
  resolveAgentKeySecretFromEnv,
} from '../utils/agent-key-credentials.js';

let tmpDir: string | undefined;

function sidecar(content = 'agent-key-material'): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'agent-key-creds-test-'));
  const path = join(tmpDir, `key-${Math.random().toString(36).slice(2)}.secret`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('parseAgentKeyFileMap', () => {
  it('parses a valid variant map and trims paths', () => {
    expect(parseAgentKeyFileMap('{"a":"/k/a.secret","b":" /k/b.secret "}')).toEqual({
      a: '/k/a.secret',
      b: '/k/b.secret',
    });
  });

  it('drops empty-path entries', () => {
    expect(parseAgentKeyFileMap('{"a":"  ","b":"/k/b.secret"}')).toEqual({ b: '/k/b.secret' });
  });

  it('bad JSON / arrays / scalars / empty → {}', () => {
    expect(parseAgentKeyFileMap('not json')).toEqual({});
    expect(parseAgentKeyFileMap('["/k/a.secret"]')).toEqual({});
    expect(parseAgentKeyFileMap('"just-a-string"')).toEqual({});
    expect(parseAgentKeyFileMap('')).toEqual({});
    expect(parseAgentKeyFileMap(undefined)).toEqual({});
  });
});

describe('readAgentKeyFileSync / agentKeyFileUsable', () => {
  it('reads and trims a real file; blank file is unusable', () => {
    const path = sidecar('  material  \n');
    expect(readAgentKeyFileSync(path)).toBe('material');
    expect(agentKeyFileUsable(path)).toBe(true);

    const blank = sidecar('   \n');
    expect(agentKeyFileUsable(blank)).toBe(false);
  });

  it('missing/unreadable path → undefined / false, never throws', () => {
    expect(readAgentKeyFileSync(undefined)).toBeUndefined();
    expect(readAgentKeyFileSync('/nonexistent/agent-key.secret')).toBeUndefined();
    expect(agentKeyFileUsable('/nonexistent/agent-key.secret')).toBe(false);
  });
});

describe('hasUsableAgentKeyCredentials', () => {
  it('SECRET: non-blank usable, empty/whitespace-only rejected (round-3 restore)', () => {
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_SECRET: 'secret-material' })).toBe(true);
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_SECRET: '' })).toBe(false);
    // #1494 round 3: a whitespace-only secret is no material — HTTP header
    // transport normalizes it to an empty value, so it must not count.
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_SECRET: '   ' })).toBe(false);
  });

  it('single FILE counts only when the literal path reads non-empty (no path trimming)', () => {
    const path = sidecar();
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILE: path })).toBe(true);
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILE: '/nonexistent.secret' })).toBe(false);
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILE: '   ' })).toBe(false);
    // The resolver reads the single-FILE path literally; surrounding spaces
    // name a different (missing) file, so availability must agree (#1494).
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILE: ` ${path} ` })).toBe(false);
  });

  it('non-empty FILES disables fallback: {} map, bad JSON, all-missing sidecars → false even with SECRET set', () => {
    const path = sidecar();
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILES: '{}', CAT_CAFE_AGENT_KEY_SECRET: 's' })).toBe(
      false,
    );
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILES: 'not-json', CAT_CAFE_AGENT_KEY_SECRET: 's' })).toBe(
      false,
    );
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_FILES: '{"a":"/nonexistent.secret"}',
        CAT_CAFE_AGENT_KEY_SECRET: 's',
      }),
    ).toBe(false);
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_FILES: `{"a":"/nonexistent.secret","b":"${path}"}`,
        CAT_CAFE_AGENT_KEY_SECRET: 's',
      }),
    ).toBe(true);
  });

  it('bound identity: only its own map entry qualifies — unrelated readable keys, SECRET, or single FILE do not', () => {
    const antigravityPath = sidecar();
    const gptProPath = sidecar();
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: antigravityPath }),
      }),
    ).toBe(false);
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: antigravityPath, 'gpt-pro': gptProPath }),
      }),
    ).toBe(true);
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_SECRET: 'unbound-secret',
      }),
    ).toBe(false);
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro' })).toBe(false);
    // Map paths are trimmed by the parser, so a padded entry still resolves.
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ 'gpt-pro': `  ${gptProPath}  ` }),
      }),
    ).toBe(true);
  });

  it('no vars at all → false', () => {
    expect(hasUsableAgentKeyCredentials({})).toBe(false);
  });
});

describe('resolveAgentKeySecretFromEnv', () => {
  it('requested identity must match the bound identity', () => {
    const path = sidecar();
    const env = {
      CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
      CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ 'gpt-pro': path }),
    };
    expect(resolveAgentKeySecretFromEnv(env, { agentKeyCatId: 'antigravity' })).toBeUndefined();
    expect(resolveAgentKeySecretFromEnv(env, { agentKeyCatId: 'gpt-pro' })).toBe('agent-key-material');
    expect(resolveAgentKeySecretFromEnv(env)).toBe('agent-key-material');
  });

  it('variant map present without an effective identity resolves nothing at mount level', () => {
    const path = sidecar();
    const env = { CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: path }) };
    expect(resolveAgentKeySecretFromEnv(env)).toBeUndefined();
    expect(resolveAgentKeySecretFromEnv(env, { agentKeyCatId: 'antigravity' })).toBe('agent-key-material');
  });

  it('falls back SECRET → literal single FILE only when no variant map exists', () => {
    const path = sidecar();
    expect(resolveAgentKeySecretFromEnv({ CAT_CAFE_AGENT_KEY_SECRET: 's' })).toBe('s');
    expect(resolveAgentKeySecretFromEnv({ CAT_CAFE_AGENT_KEY_FILE: path })).toBe('agent-key-material');
    expect(resolveAgentKeySecretFromEnv({ CAT_CAFE_AGENT_KEY_FILE: ` ${path} ` })).toBeUndefined();
    expect(
      resolveAgentKeySecretFromEnv({ CAT_CAFE_AGENT_KEY_FILES: '{}', CAT_CAFE_AGENT_KEY_FILE: path }),
    ).toBeUndefined();
  });

  it('SECRET gate rejects blank material but returns the original bytes for non-blank keys', () => {
    expect(resolveAgentKeySecretFromEnv({ CAT_CAFE_AGENT_KEY_SECRET: '   ' })).toBeUndefined();
    expect(resolveAgentKeySecretFromEnv({ CAT_CAFE_AGENT_KEY_SECRET: '\t\n' })).toBeUndefined();
    expect(resolveAgentKeySecretFromEnv({ CAT_CAFE_AGENT_KEY_SECRET: ' s ' })).toBe(' s ');
  });
});
