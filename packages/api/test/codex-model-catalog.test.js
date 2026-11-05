/**
 * Codex custom-model catalog injection (`--config model_catalog_json=...`).
 *
 * The CLI logs "Model metadata for deepseek-flash not found. Defaulting to
 * fallback metadata" for routed custom models with no built-in catalog entry.
 * The injected catalog removes that fallback path. Because the flag REPLACES
 * the built-in catalog wholesale, it must stay gated per-model and reserved
 * against free-form cliConfigArgs.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const { CodexAgentService: ProductionCodexAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAgentService.js'
);
const {
  CODEX_CUSTOM_MODEL_CATALOG_ENTRIES,
  buildCodexModelCatalogArgs,
  buildCodexModelCatalogFileContent,
  resolveCodexModelCatalogPath,
  withoutUpdatePlanInstructions,
} = await import('../dist/domains/cats/services/agents/providers/codex-model-catalog.js');

class CodexAgentService extends ProductionCodexAgentService {
  constructor(options = {}) {
    super({ ...options, cliCommand: process.execPath });
  }
}

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') {
      process.nextTick(() => originalEmit('close', ...args));
    }
    return emitted;
  };
  const proc = {
    stdout,
    stderr,
    stdin: { write: () => true, end: () => {}, on: () => proc.stdin },
    pid: 12345,
    exitCode: null,
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  proc.kill = mock.fn(() => true);
  return proc;
}

/**
 * Defer the scripted events until spawn has attached its listeners; emitting
 * before the spawn call races the generator's pre-spawn awaits (first config
 * load can outlive a bare setImmediate).
 */
function createDeferredSpawnFn(proc, threadId) {
  return mock.fn(() => {
    setImmediate(() => emitCodexEvents(proc, [{ type: 'thread.started', thread_id: threadId }]));
    return proc;
  });
}

function emitCodexEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  setImmediate(() => {
    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);
  });
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function findCatalogPath(args) {
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === '--config' && typeof args[i + 1] === 'string' && args[i + 1].startsWith('model_catalog_json=')) {
      return args[i + 1].slice('model_catalog_json='.length);
    }
  }
  return null;
}

describe('codex custom-model catalog injection', () => {
  test('injects the catalog for a custom model and materializes valid JSON', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-custom');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'deepseek-flash',
    });

    const promise = collect(service.invoke('hello', {}));
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const path = findCatalogPath(args);
    assert.ok(path, `catalog flag missing from argv: ${JSON.stringify(args)}`);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const entry = parsed.models.find((item) => item.slug === 'deepseek-flash');
    assert.ok(entry, 'catalog must contain the deepseek-flash entry');
    assert.equal(
      entry.model_messages.instructions_template.includes('{{'),
      false,
      'instructions template must be pre-rendered fallback text',
    );
    assert.ok(entry.model_messages.instructions_template.includes('Codex CLI'));
    assert.equal(
      entry.model_messages.instructions_template.includes('update_plan'),
      false,
      'the default invocation does not expose update_plan, so its instructions must be filtered like fallback metadata',
    );
    assert.equal(entry.context_window, undefined, 'no native window source means no advertised window');
    assert.equal(entry.max_context_window, undefined, 'no native window source means no advertised ceiling');
    assert.ok(entry.supported_reasoning_levels.some((level) => level.effort === 'max'));
  });

  test('does not inject the catalog for builtin models', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-builtin');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'gpt-5.6-sol',
    });

    const promise = collect(service.invoke('hello', {}));
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(findCatalogPath(args), null, `builtin model must not get a catalog: ${JSON.stringify(args)}`);
  });

  test('reserved: free-form cliConfigArgs cannot override model_catalog_json', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-reserved');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'deepseek-flash',
    });

    const promise = collect(
      service.invoke('hello', {
        cliConfigArgs: [
          '--config model_catalog_json=/tmp/evil.json',
          '-c=model_catalog_json=/tmp/evil2.json',
          '--config=model_catalog_json=/tmp/evil3.json',
        ],
      }),
    );
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const catalogArgs = args.filter((arg) => typeof arg === 'string' && arg.startsWith('model_catalog_json='));
    assert.equal(catalogArgs.length, 1, `exactly the system catalog pair must survive: ${JSON.stringify(args)}`);
    assert.ok(!catalogArgs[0].includes('evil'), 'user-supplied catalog path must not survive');
  });

  test('module catalog entries carry the CLI-required schema fields', () => {
    const requiredFields = [
      'slug',
      'display_name',
      'supported_reasoning_levels',
      'shell_type',
      'visibility',
      'supported_in_api',
      'priority',
      'support_verbosity',
      'truncation_policy',
      'supports_parallel_tool_calls',
      'experimental_supported_tools',
      'model_messages',
    ];
    for (const [slug, entry] of Object.entries(CODEX_CUSTOM_MODEL_CATALOG_ENTRIES)) {
      assert.equal(entry.slug, slug, 'entry slug must match its map key');
      for (const field of requiredFields) {
        assert.ok(field in entry, `entry ${slug} is missing ${field}`);
      }
    }
    const parsed = JSON.parse(buildCodexModelCatalogFileContent({ nativeContextWindowTokens: 1_000_000 }));
    assert.deepEqual(
      parsed.models.map((item) => item.slug).sort(),
      Object.keys(CODEX_CUSTOM_MODEL_CATALOG_ENTRIES).sort(),
    );
    for (const item of parsed.models) {
      assert.equal(item.context_window, 1_000_000, `entry ${item.slug} must carry the invocation native window`);
      assert.equal(item.max_context_window, 1_000_000, `entry ${item.slug} must carry the matching ceiling`);
    }
  });

  // Codex pins both windows to 272_000 for models missing from its own catalog
  // and then applies `min(--config model_context_window, max_context_window)`,
  // so a configured 1M window was silently clamped to 272_000 (258_400 usable).
  // The entry must therefore declare the native window, and it must reach the
  // serialized file — a value readable only from the typed constant would not
  // change what the CLI sees.
  // Regression for a P1 caught in review: the line array was joined with
  // "'\n'" (quote + newline + quote) instead of "\n", so every line boundary
  // carried a stray pair of quotes into the system prompt. The catalog file is
  // what the CLI actually reads, so assert on the serialized artifact.
  //
  // The 16,979-char adapted text is exactly what codex-cli 0.163.0 sends when
  // it renders fallback metadata with update_plan disabled (measured through a
  // loopback Responses fixture). If this changes, re-measure against the CLI;
  // do not merely update the number.
  test('default catalog instructions match the CLI fallback text with update_plan disabled', () => {
    const parsed = JSON.parse(buildCodexModelCatalogFileContent());
    for (const item of parsed.models) {
      const template = item.model_messages.instructions_template;
      assert.equal(typeof template, 'string', `entry ${item.slug} must carry a template`);
      assert.ok(!template.includes("'\n'"), 'template must not contain a quote-wrapped join separator');
      assert.ok(!/(?:^|\n)'|'(?:\n|$)/.test(template), 'no line may start or end with a stray quote');
      assert.equal(template.includes('update_plan'), false, 'disabled update_plan guidance must be removed');
      assert.equal(template.length, 16_979, 'instructions must match the CLI-adapted fallback text');
      assert.equal(
        createHash('sha256').update(template, 'utf8').digest('hex'),
        '3b08633fa672906666659d764864dfda1d7af5b5111ea5817c8f46e5de4e1a8d',
        'instructions must stay byte-identical to the CLI-adapted fallback text',
      );
    }
  });

  // The snapshot is a pinned upstream asset, not a hand-maintained paraphrase:
  // openai/codex rust-v0.163.0 codex-rs/models-manager/prompt.md with its single
  // trailing LF removed. If this hash changes, update the source pin and the
  // sync script output together.
  test('raw fallback snapshot matches the pinned upstream source hash when update_plan is enabled', () => {
    const parsed = JSON.parse(buildCodexModelCatalogFileContent({ updatePlanEnabled: true }));
    const template = parsed.models[0].model_messages.instructions_template;
    assert.ok(template.includes('update_plan'), 'enabled update_plan tools need the full template');
    assert.equal(template.length, 20_750, 'raw template must stay byte-identical to the upstream prompt.md');
    assert.equal(
      createHash('sha256').update(template, 'utf8').digest('hex'),
      'ebfcbdce4a6c353e85d6cde37e508b89c77a902bd27771c91caba5fd494bdb83',
      'fallback instructions must stay byte-identical to the pinned upstream prompt.md',
    );
  });

  // Ports the upstream `update_plan_instructions_tests.rs` fixtures so a future
  // edit cannot quietly remove unrelated planning guidance.
  test('update_plan filtering matches the CLI semantics', () => {
    assert.equal(
      withoutUpdatePlanInstructions(
        'Before.\n\n## Planning\nYou have access to an `update_plan` tool which tracks steps.\n\n### Examples\nKeep steps current.\n\n## Work\nImplement.\n\n## `update_plan`\nUpdate the checklist.\n\n# Next\n## Planning\nDiscuss architecture and inspect update_plan before editing.\n',
      ),
      'Before.\n\n## Work\nImplement.\n\n# Next\n## Planning\nDiscuss architecture and inspect update_plan before editing.\n',
    );
    assert.equal(
      withoutUpdatePlanInstructions(
        '# Plan Mode\nKeep planning.\n\n## Plan Mode vs update_plan tool\nThe tools are separate.\n\n## Execution\nDo not edit.\n\n## Plan tool\nWhen using the planning tool:\n- Update steps.\n',
      ),
      '# Plan Mode\nKeep planning.\n\n## Execution\nDo not edit.\n\n',
    );
    assert.equal(
      withoutUpdatePlanInstructions(
        'Keep working.\n- Use the plan tool to explain the work\n    - Skip simple tasks.\n    - Keep steps current.\n- Explain discoveries.\n- If you create a checklist or task list, update its statuses.\n\nProgress visibility:\nIf update_plan is available, use it for complex work.\n\nCompletion:\nVerify the result.\n',
      ),
      'Keep working.\n- Explain discoveries.\n\nCompletion:\nVerify the result.\n',
    );
  });

  test('does not inject the catalog on the app_server carrier', () => {
    assert.deepEqual(
      buildCodexModelCatalogArgs('deepseek-flash', { carrier: 'app_server' }),
      [],
      'app_server does not receive the per-invocation window override, so it must not get the catalog',
    );
    assert.ok(
      buildCodexModelCatalogArgs('deepseek-flash', { carrier: 'exec_json' }).length > 0,
      'exec_json must still receive the catalog',
    );
  });

  test('custom entries declare the invocation native window that the CLI actually clamps against', () => {
    const parsed = JSON.parse(buildCodexModelCatalogFileContent({ nativeContextWindowTokens: 1_000_000 }));
    for (const item of parsed.models) {
      assert.equal(item.context_window, 1_000_000, `entry ${item.slug} must advertise the native 1M window`);
      assert.equal(
        item.max_context_window,
        1_000_000,
        `entry ${item.slug} must not lower the configurable ceiling (Codex clamps with min())`,
      );
      assert.equal(
        item.context_window,
        item.max_context_window,
        `entry ${item.slug} default window must equal its ceiling`,
      );
    }
  });

  test('catalog windows are bound to the invocation source, not a global model default', () => {
    const million = buildCodexModelCatalogFileContent({ nativeContextWindowTokens: 1_000_000 });
    const twoHundredThousand = buildCodexModelCatalogFileContent({ nativeContextWindowTokens: 200_000 });
    const unconfigured = buildCodexModelCatalogFileContent({ nativeContextWindowTokens: null });

    assert.equal(JSON.parse(twoHundredThousand).models[0].context_window, 200_000);
    assert.equal(JSON.parse(unconfigured).models[0].context_window, undefined);
    assert.notEqual(resolveCodexModelCatalogPath(million), resolveCodexModelCatalogPath(twoHundredThousand));
    assert.notEqual(resolveCodexModelCatalogPath(million), resolveCodexModelCatalogPath(unconfigured));
  });

  test('provider-prefixed spellings of the same slug keep each invocation window', () => {
    const providerAArgs = buildCodexModelCatalogArgs('provider-a/deepseek-flash', {
      nativeContextWindowTokens: 1_000_000,
    });
    const providerBArgs = buildCodexModelCatalogArgs('provider-b/deepseek-flash', {
      nativeContextWindowTokens: 200_000,
    });
    const providerUnconfiguredArgs = buildCodexModelCatalogArgs('provider-c/deepseek-flash', {
      nativeContextWindowTokens: null,
    });

    const providerAPath = findCatalogPath(providerAArgs);
    const providerBPath = findCatalogPath(providerBArgs);
    const providerUnconfiguredPath = findCatalogPath(providerUnconfiguredArgs);
    assert.ok(providerAPath && providerBPath && providerUnconfiguredPath, 'all provider routes must get a catalog');
    assert.notEqual(providerAPath, providerBPath, 'different native windows need different catalog files');
    assert.notEqual(providerAPath, providerUnconfiguredPath, 'unconfigured must not reuse a numeric window');

    const readEntry = (path) =>
      JSON.parse(readFileSync(path, 'utf8')).models.find((item) => item.slug === 'deepseek-flash');
    assert.equal(readEntry(providerAPath).context_window, 1_000_000);
    assert.equal(readEntry(providerBPath).context_window, 200_000);
    assert.equal(readEntry(providerUnconfiguredPath).context_window, undefined);
    assert.equal(readEntry(providerUnconfiguredPath).max_context_window, undefined);
  });

  test('service carries the invocation native window into the catalog and argv', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-native-window');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'deepseek-flash',
    });

    const promise = collect(service.invoke('hello', { contextNativeWindowTokens: 200_000 }));
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const path = findCatalogPath(args);
    assert.ok(path, `catalog flag missing from argv: ${JSON.stringify(args)}`);
    const entry = JSON.parse(readFileSync(path, 'utf8')).models.find((item) => item.slug === 'deepseek-flash');
    assert.equal(entry.context_window, 200_000, 'catalog must use this invocation native window');
    assert.equal(entry.max_context_window, 200_000, 'catalog ceiling must match the native window');
    assert.ok(args.includes('model_context_window=200000'), `configured window missing: ${JSON.stringify(args)}`);
  });

  test('service preserves unconfigured window semantics when the invocation has no native window', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-no-native-window');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'deepseek-flash',
    });

    const promise = collect(
      service.invoke('hello', {
        contextCapacity: { windowTokens: 258_400, inputCeilingTokens: 240_000, actionable: true },
        contextNativeWindowTokens: null,
      }),
    );
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const path = findCatalogPath(args);
    assert.ok(path, `catalog flag missing from argv: ${JSON.stringify(args)}`);
    const entry = JSON.parse(readFileSync(path, 'utf8')).models.find((item) => item.slug === 'deepseek-flash');
    assert.equal(entry.context_window, undefined, 'report-derived capacity must not become a catalog native window');
    assert.equal(entry.max_context_window, undefined, 'report-derived capacity must not become a catalog ceiling');
    assert.equal(
      args.some((arg) => arg.startsWith('model_context_window=')),
      false,
      `no native window source means no model_context_window: ${JSON.stringify(args)}`,
    );
  });

  test('service keeps the full template when the invocation explicitly enables update_plan', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-update-plan-enabled');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'deepseek-flash',
    });

    const promise = collect(service.invoke('hello', { cliConfigArgs: ['-c tools.update_plan.enabled=true'] }));
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const path = findCatalogPath(args);
    const template = JSON.parse(readFileSync(path, 'utf8')).models[0].model_messages.instructions_template;
    assert.ok(template.includes('update_plan'), 'explicitly enabled update_plan must retain its instructions');
    assert.equal(template.length, 20_750, 'enabled update_plan must use the raw pinned template');
  });

  test('service resolves update_plan from the final CLI override, including parent-table replacement', async () => {
    const cases = [
      {
        name: 'later duplicate leaf disables',
        args: ['-c tools.update_plan.enabled=true', '-c tools.update_plan.enabled=false'],
        enabled: false,
      },
      {
        name: 'later duplicate leaf enables',
        args: ['-c tools.update_plan.enabled=false', '-c tools.update_plan.enabled=true'],
        enabled: true,
      },
      {
        name: 'parent table replacement disables',
        args: ['-c tools.update_plan.enabled=true', '-c tools={update_plan={enabled=false}}'],
        enabled: false,
      },
      {
        name: 'parent table replacement drops the leaf',
        args: ['-c tools.update_plan.enabled=true', '-c tools={other={enabled=true}}'],
        enabled: false,
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const proc = createMockProcess();
      const spawnFn = createDeferredSpawnFn(proc, `t-catalog-update-plan-final-${index}`);
      const service = new CodexAgentService({
        l0CompilerFn: fakeL0Compiler,
        spawnFn,
        catId: 'runtime-sol',
        model: 'deepseek-flash',
      });

      await collect(service.invoke('hello', { cliConfigArgs: entry.args }));

      const args = spawnFn.mock.calls[0].arguments[1];
      const path = findCatalogPath(args);
      assert.ok(path, `${entry.name}: catalog flag missing from argv: ${JSON.stringify(args)}`);
      const template = JSON.parse(readFileSync(path, 'utf8')).models[0].model_messages.instructions_template;
      assert.equal(
        template.includes('update_plan'),
        entry.enabled,
        `${entry.name}: template must follow the CLI's final update_plan visibility`,
      );
      assert.equal(
        template.length,
        entry.enabled ? 20_750 : 16_979,
        `${entry.name}: template must match the CLI-adapted fallback text`,
      );
    }
  });

  test('rebuilds a corrupted content-addressed cache file instead of trusting its name', () => {
    withIsolatedCatalogTmpdir((root) => {
      const options = { nativeContextWindowTokens: 200_000 };
      const expected = buildCodexModelCatalogFileContent(options);
      const path = resolveCodexModelCatalogPath(expected);
      assert.ok(path.startsWith(root), `test tmpdir was not honored: ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{broken JSON');

      const args = buildCodexModelCatalogArgs('deepseek-flash', options);
      assert.ok(findCatalogPath(args), `corrupt cache must be rebuilt, got: ${JSON.stringify(args)}`);
      assert.equal(readFileSync(path, 'utf8'), expected, 'cache must be restored to the requested bytes');
      assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')), 'restored cache must be valid JSON');
    });
  });

  test('rebuilds a valid but content-mismatched cache file', () => {
    withIsolatedCatalogTmpdir((root) => {
      const options = { nativeContextWindowTokens: 200_000 };
      const expected = buildCodexModelCatalogFileContent(options);
      const path = resolveCodexModelCatalogPath(expected);
      assert.ok(path.startsWith(root), `test tmpdir was not honored: ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ models: [{ slug: 'deepseek-flash', context_window: 999 }] }));

      const args = buildCodexModelCatalogArgs('deepseek-flash', options);
      assert.ok(findCatalogPath(args), `mismatched cache must be rebuilt, got: ${JSON.stringify(args)}`);
      assert.equal(readFileSync(path, 'utf8'), expected, 'cache must be restored to the requested bytes');
    });
  });

  test(
    'replaces a planted symlink at the cache path instead of following it',
    { skip: process.platform === 'win32' },
    () => {
      withIsolatedCatalogTmpdir((root) => {
        const options = { nativeContextWindowTokens: 200_000 };
        const expected = buildCodexModelCatalogFileContent(options);
        const path = resolveCodexModelCatalogPath(expected);
        assert.ok(path.startsWith(root), `test tmpdir was not honored: ${path}`);
        mkdirSync(dirname(path), { recursive: true });
        const outside = join(root, 'outside.json');
        writeFileSync(outside, JSON.stringify({ models: [] }));
        symlinkSync(outside, path);

        const args = buildCodexModelCatalogArgs('deepseek-flash', options);
        assert.ok(findCatalogPath(args), `symlink cache must not be trusted, got: ${JSON.stringify(args)}`);
        const stats = lstatSync(path);
        assert.equal(stats.isFile(), true, 'cache path must become a regular file');
        assert.equal(stats.isSymbolicLink(), false, 'cache path must not remain a symlink');
        assert.equal(readFileSync(path, 'utf8'), expected);
        assert.equal(
          readFileSync(outside, 'utf8'),
          JSON.stringify({ models: [] }),
          'outside target must stay untouched',
        );
      });
    },
  );
});

function withIsolatedCatalogTmpdir(run) {
  const root = mkdtempSync(join(tmpdir(), 'codex-catalog-integrity-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    return run(root);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
