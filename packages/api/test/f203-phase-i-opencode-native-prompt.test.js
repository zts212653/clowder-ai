/**
 * F203/F257 — OpenCode native session prompt guard tests
 *
 * Covers AC-I1 through AC-I7:
 * - AC-I2: opencode-config-template outputs `instructions` array
 * - AC-I3: OpenCodeAgentService.injectsL0Natively() → true
 * - AC-I5: golden-chinchilla workflow triggers exist in HookPipeline output
 * - AC-I6: runtime config merge does not break permission/plugin/compaction
 * - AC-I7 ①②: route-owned prompt + config chain
 * - AC-I7 ③: instructions-only config content (no provider block)
 * - AC-I7 ④: OC_INSTRUCTIONS_ONLY_ENV auth preservation signal
 * - AC-I7 ⑤: missing route-owned prompt fails closed
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { generateOpenCodeRuntimeConfig } from '../dist/domains/cats/services/agents/providers/opencode-config-template.js';
import { writeOpenCodeRuntimeConfig } from '../dist/domains/cats/services/agents/providers/opencode-config-writer.js';

const projectRoot = resolve(import.meta.dirname, '../../..');
const projectOpenCodeConfigPath = join(projectRoot, 'opencode.json');
const projectOpenCodeInstructionsPath = join(projectRoot, 'OPENCODE.md');
const hasProjectOpenCodeRuntimeFiles =
  existsSync(projectOpenCodeConfigPath) && existsSync(projectOpenCodeInstructionsPath);
const projectRuntimeInvariantOptions = hasProjectOpenCodeRuntimeFiles
  ? {}
  : {
      skip: 'public checkout does not include local OpenCode runtime config files; committed template tests still run',
    };

// ── AC-I3: OpenCodeAgentService.injectsL0Natively() ──

describe('F203 Phase I — OpenCodeAgentService native marker', () => {
  test('injectsL0Natively() returns true', () => {
    const service = new OpenCodeAgentService({ catId: 'opencode', model: 'anthropic/claude-opus-4-6' });
    assert.strictEqual(
      service.injectsL0Natively(),
      true,
      'OpenCodeAgentService must declare native prompt injection so route layer keeps packs separate',
    );
  });
});

// ── AC-I2: opencode-config-template instructions support ──

describe('F203 Phase I — opencode-config-template instructions', () => {
  test('generateOpenCodeRuntimeConfig includes instructions when provided', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
      instructions: ['/tmp/session-prompt.md', '/project/OPENCODE.md'],
    });

    assert.ok(config.instructions, 'config must have instructions field');
    assert.deepStrictEqual(config.instructions, ['/tmp/session-prompt.md', '/project/OPENCODE.md']);
  });

  test('generateOpenCodeRuntimeConfig omits instructions when empty', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
      instructions: [],
    });

    assert.strictEqual(config.instructions, undefined, 'empty instructions should not produce field');
  });

  test('generateOpenCodeRuntimeConfig omits instructions when not provided', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
    });

    assert.strictEqual(config.instructions, undefined, 'no instructions option → no field');
  });

  test('writeOpenCodeRuntimeConfig writes instructions to disk', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tempRoot = mkdtempSync(join(tmpdir(), 'f203-i-test-'));
    try {
      const configPath = await writeOpenCodeRuntimeConfig(tempRoot, 'opencode', 'inv-test-001', {
        providerName: 'anthropic',
        models: ['claude-opus-4-6'],
        instructions: ['/tmp/session-prompt.md', '/project/OPENCODE.md'],
      });

      assert.ok(existsSync(configPath), 'config file must exist on disk');
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.deepStrictEqual(
        parsed.instructions,
        ['/tmp/session-prompt.md', '/project/OPENCODE.md'],
        'written config must contain instructions array',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('instructions coexist with MCP and provider config', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
      mcpServerPath: '/path/to/mcp-server.js',
      instructions: ['/tmp/session-prompt.md'],
    });

    assert.ok(config.instructions, 'instructions present');
    assert.ok(config.mcp, 'MCP present');
    assert.ok(config.provider, 'provider present');
  });
});

// ── AC-I5: golden-chinchilla workflow triggers ──

describe('F203 Phase I — golden-chinchilla workflow triggers', () => {
  test('opencode session hooks include workflow triggers', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opencode', { mcpAvailable: true });

    assert.ok(prompt.includes('金渐层家族治理'), 'must contain golden-chinchilla governance section');
    assert.ok(prompt.includes('OMOC Sisyphus'), 'must mention OMOC orchestration boundary');
    assert.ok(!prompt.includes('（无 per-breed 触发点配置）'), 'must NOT fall back to empty triggers');
  });

  test('opencode session hooks contain identity block', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opencode', { mcpAvailable: true });

    assert.ok(prompt.includes('金渐层'), 'must contain 金渐层 identity');
    assert.ok(prompt.includes('OMOC'), 'must contain this cat family boundary');
  });

  test('opencode session hooks contain teammate roster', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opencode', { mcpAvailable: true });

    assert.ok(prompt.includes('队友名册'), 'must contain teammate roster section');
    // opencode should not list itself in roster
    assert.ok(!prompt.includes('| 金渐层'), 'opencode must not appear in its own roster');
  });

  test('opencode session hooks contain governance', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opencode', { mcpAvailable: true });

    assert.ok(prompt.includes('家规'), 'must contain governance section');
    assert.ok(prompt.includes('Rule 0'), 'must contain Rule 0');
  });
});

// ── AC-I6: permission/plugin/compaction not broken ──

describe('F203 Phase I — OpenCode runtime invariants (AC-I6)', () => {
  test('project opencode.json still has permission.question=deny', projectRuntimeInvariantOptions, () => {
    const config = JSON.parse(readFileSync(projectOpenCodeConfigPath, 'utf8'));

    assert.strictEqual(
      config.permission?.question,
      'deny',
      'permission.question must remain "deny" — enforcement is in config, not OPENCODE.md prose',
    );
  });

  test('project opencode.json still has OMOC plugin', projectRuntimeInvariantOptions, () => {
    const config = JSON.parse(readFileSync(projectOpenCodeConfigPath, 'utf8'));

    const plugins = config.plugin ?? config.plugins ?? [];
    const hasOmoc = plugins.some((p) => typeof p === 'string' && p.includes('oh-my-opencode'));
    assert.ok(hasOmoc, 'OMOC plugin must be preserved in project opencode.json');
  });

  test('project opencode.json still has compaction config', projectRuntimeInvariantOptions, () => {
    const config = JSON.parse(readFileSync(projectOpenCodeConfigPath, 'utf8'));

    assert.ok(config.compaction, 'compaction config must be preserved');
    assert.strictEqual(config.compaction.auto, true, 'compaction.auto must remain true');
  });

  test('OPENCODE.md still exists and contains interaction channel rules', projectRuntimeInvariantOptions, () => {
    const content = readFileSync(projectOpenCodeInstructionsPath, 'utf8');

    assert.ok(content.includes('question'), 'OPENCODE.md must document question tool deny');
    assert.ok(content.includes('cat_cafe_create_rich_block'), 'OPENCODE.md must document rich block alternative');
  });
});

// ── AC-I7 ③④⑤: explicit route/invoke/fail-closed guards (砚砚 P1-1 re-review) ──

describe('F203 Phase I — instructions-only config content verification', () => {
  test('writeOpenCodeInstructionsOnlyConfig writes ONLY schema + instructions (no provider)', async () => {
    const { writeOpenCodeInstructionsOnlyConfig } = await import(
      '../dist/domains/cats/services/agents/providers/opencode-config-writer.js'
    );
    const { mkdtempSync, rmSync, readFileSync: readFs } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tempRoot = mkdtempSync(join(tmpdir(), 'f203-i-instr-only-'));
    try {
      const configPath = writeOpenCodeInstructionsOnlyConfig(tempRoot, 'opencode', 'inv-test', [
        '/tmp/session-prompt.md',
        '/project/OPENCODE.md',
      ]);
      const parsed = JSON.parse(readFs(configPath, 'utf8'));

      assert.deepStrictEqual(parsed.instructions, ['/tmp/session-prompt.md', '/project/OPENCODE.md']);
      assert.strictEqual(parsed.$schema, 'https://opencode.ai/config.json');
      // MUST NOT have provider block — otherwise buildEnv clears auth
      assert.strictEqual(parsed.provider, undefined, 'instructions-only config must NOT have provider');
      assert.strictEqual(parsed.model, undefined, 'instructions-only config must NOT have model');
      assert.strictEqual(parsed.mcp, undefined, 'instructions-only config must NOT have mcp');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('F203 Phase I — buildEnv auth preservation (pointer tests)', () => {
  test('OC_INSTRUCTIONS_ONLY_ENV constant is exported', async () => {
    const mod = await import('../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js');
    assert.strictEqual(mod.OC_INSTRUCTIONS_ONLY_ENV, 'CAT_CAFE_OC_INSTRUCTIONS_ONLY');
    // Real runtime auth test: opencode-agent-service.test.js
    // "F203-I: OPENCODE_CONFIG + OC_INSTRUCTIONS_ONLY preserves ANTHROPIC_API_KEY"
    // — walks service.invoke() → buildEnv() → spawnFn with preserved auth.
  });
});

describe('F257 S5 — native prompt fail-closed', () => {
  test('missing route-owned prompt is rejected', async () => {
    const { resolveNativeSessionPrompt } = await import(
      '../dist/domains/cats/services/agents/providers/native-session-prompt.js'
    );
    await assert.rejects(resolveNativeSessionPrompt({}, 'opencode'), /HookPipeline session prompt missing/);
  });

  test('exact route-owned bytes pass through unchanged', async () => {
    const { resolveNativeSessionPrompt } = await import(
      '../dist/domains/cats/services/agents/providers/native-session-prompt.js'
    );
    const prompt = 'route-owned\nHookPipeline bytes';
    assert.equal(await resolveNativeSessionPrompt({ nativeSessionPrompt: prompt }, 'opencode'), prompt);
  });
});
