import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import {
  humanSessionFirstLine,
  isCatCafeSessionInput,
  isLocalSessionId,
  localSessionImportTool,
} from '../../shared/src/utils/local-session-import.js';

test('legacy OpenCode identity headers are origin evidence only at the input start', () => {
  const legacy = '你是 金渐层（opencode），由 opencode 提供的 AI 猫猫。';
  assert.equal(isCatCafeSessionInput(legacy + '\n原生身份说明'), true);
  assert.equal(isCatCafeSessionInput('"' + legacy + '\n原生身份说明'), true);
  assert.equal(isCatCafeSessionInput("'" + legacy + '\n原生身份说明'), true);
  assert.equal(isCatCafeSessionInput('讨论这个旧提示：\n' + legacy), false);
  assert.equal(isCatCafeSessionInput('你是一个设计助手，请解释 AI 猫猫。'), false);
  assert.equal(isCatCafeSessionInput('你是 金渐层（opencode），由其他软件提供的 AI 猫猫。'), false);
});

test('the current production prompt prefixes remain recognizable in their actual prepend order', async () => {
  const { catRegistry, createCatId } = await import('@cat-cafe/shared');
  const { loadCatConfig, toAllCatConfigs } = await import('../src/config/cat-config-loader.js');
  const { buildInvocationContext } = await import('../src/domains/cats/services/context/SystemPromptBuilder.js');
  const { buildStagingPrepend } = await import('../src/domains/cats/services/context/StagingContent.js');
  const { RoutingContextPromptProjector } = await import(
    '../src/domains/routing-context/RoutingContextPromptProjector.js'
  );
  // Same read-model fixture shape as routing-context-prompt-projector.test.js;
  // only the production projector supplies the routing envelope bytes.
  const routing = new RoutingContextPromptProjector().project({
    v: 1,
    ownerId: 'owner-1',
    observedAt: 10_000,
    catalogRevision: 'catalog:v1',
    resolution: {
      state: 'fresh',
      snapshot: {
        v: 1,
        ownerId: 'owner-1',
        observedAt: 10_000,
        catalogRevision: 'catalog:v1',
        candidates: [
          {
            binding: { v: 1, catId: 'codex', providerId: 'openai', provenQuotaPools: [] },
            profile: { state: 'absent' },
            availability: 'unavailable',
            freshness: 'fresh',
            reasons: [
              { code: 'routing_signal_unavailable', summary: 'Unavailable fixture', sourceRefs: ['signal:test'] },
            ],
            matchedPreferences: [],
            effect: 'blocked',
          },
        ],
      },
      inputRevisionRef: 'sha256:input',
      sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
    },
    signalEvents: [],
    preferenceRevisions: [],
  });
  assert.ok(routing, 'the routing fixture must produce an actual prepend');
  for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig('../../cat-template.json')))) {
    if (!catRegistry.has(id)) catRegistry.register(id, config);
  }
  for (const id of ['opus', 'codex', 'glm52']) {
    const identity = buildInvocationContext({
      catId: createCatId(id),
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      nativeL0Injected: true,
    });
    assert.ok(isCatCafeSessionInput(identity), `${id}: identity-only native input must remain recognizable`);
    const staging = buildStagingPrepend(createCatId(id));
    if (existsSync(new URL('../../../cat-cafe-skills/refs/l0-staging-content.md', import.meta.url))) {
      assert.ok(staging, `${id}: available staging content must produce an actual prepend`);
    } else {
      assert.equal(staging, '', 'public exports omit private staging content');
    }
    // invokeSingleCat prepends routing, then staging, before identity and user text.
    const withoutRouting = [staging, identity, 'Please review this code'].filter(Boolean).join('\n\n---\n\n');
    assert.ok(isCatCafeSessionInput(withoutRouting), `${id}: staging-led native input must remain recognizable`);
    assert.ok(
      isCatCafeSessionInput(`${routing}\n\n---\n\n${withoutRouting}`),
      `${id}: routing-led native input must remain recognizable`,
    );
  }
});

test('origin evidence uses leading Cafe markers, including the complete installed OpenCode plugin envelope', () => {
  for (const marker of ['<runtime-routing-context>', '> L0 Staging Layer', 'Identity:', '[Context Continuity]']) {
    assert.equal(isCatCafeSessionInput(`  ${marker} clipped`), true);
    assert.equal(isCatCafeSessionInput(`Explain ${marker} please`), false);
  }
  const plugin =
    '[search-mode]\nMAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:\n- explore agents\nNEVER stop at first result - be exhaustive.\n\n[analyze-mode]\nANALYSIS MODE. Gather context before diving deep:\nSYNTHESIZE findings before proceeding.\n---\nMANDATORY delegate_task params: ALWAYS include load_skills=[] and run_in_background when calling delegate_task.\nExample: delegate_task(subagent_type="explore", prompt="...", run_in_background=true, load_skills=[])\n\n---\n\n"';
  assert.equal(isCatCafeSessionInput(plugin + '<runtime-routing-context> clipped'), true);
  assert.equal(isCatCafeSessionInput(plugin + '你是 金渐层（opencode），由 opencode 提供的 AI 猫猫。'), true);
  assert.equal(isCatCafeSessionInput(plugin + 'Please review this code'), false);
  assert.equal(isCatCafeSessionInput('[search-mode]\nUnknown preamble\nIdentity: not source evidence'), false);
  assert.equal(isCatCafeSessionInput('---\nIdentity: a document supplied by the user'), false);
  assert.equal(isCatCafeSessionInput('"Identity: a quoted field'), false);
  assert.equal(isCatCafeSessionInput('[search-mode]\n' + 'x'.repeat(2000) + '\nIdentity: outside budget'), false);
});

test('uses a human first line without confusing quoted wrapper words with system input', () => {
  assert.equal(humanSessionFirstLine('  帮我整理发布说明\n第二行细节'), '帮我整理发布说明');
  assert.equal(humanSessionFirstLine('解释 <runtime-routing-context> 的作用'), '解释 <runtime-routing-context> 的作用');
});

test('extracts the actual Codex attachment envelope with My request, without consuming attachment instructions', () => {
  const preview =
    "# Files mentioned by the user:\n\n## codex-clipboard-real.png: /var/tmp/fixture.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n帮我检查网络错误\n第二行细节";
  assert.equal(humanSessionFirstLine(preview), '帮我检查网络错误');
});

test('does not label a clipped OpenCode mode preamble as the human request', () => {
  const preview =
    '[search-mode]\nMAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:\n- explore agents (codebase patterns, file structures, ast-grep)\n- librarian agents (remote repos, official docs, GitHub examples)\nPlus direct tools: Grep, ripgrep (rg), ast-grep (sg)\nNEVER stop at first result - be exhaustive.\n\n[analyze-mode]\nANALYSIS MODE. Gather context before diving deep:';
  assert.equal(humanSessionFirstLine(preview), '');
  assert.equal(humanSessionFirstLine('[analyze-mode]\nANALYSIS MODE. Gather context before diving deep:'), '');
  assert.equal(humanSessionFirstLine('解释 [search-mode] 的作用'), '解释 [search-mode] 的作用');
});

test('does not call a realtime delegation envelope a human first line', () => {
  assert.equal(
    humanSessionFirstLine('<realtime_delegation>\n  <input>delegated task</input>\n</realtime_delegation>'),
    '',
  );
  assert.equal(humanSessionFirstLine('<realtime_delegation> clipped'), '');
  assert.equal(humanSessionFirstLine('解释 <realtime_delegation> 的用法'), '解释 <realtime_delegation> 的用法');
});

test('native ID admission is per-tool and does not expose transports without an external-import identity contract', () => {
  assert.equal(isLocalSessionId('opencode', 'ses_real123'), true);
  assert.equal(isLocalSessionId('openai', 'ses_real123'), false);
  assert.equal(isLocalSessionId('opencode', '../escape'), false);
  assert.equal(localSessionImportTool({ clientId: 'opencode', cli: {} })?.label, 'OpenCode');
  for (const clientId of ['kimi', 'antigravity', 'google', 'acp', 'a2a'])
    assert.equal(localSessionImportTool({ clientId, cli: {} }), undefined);
  assert.equal(localSessionImportTool({ id: 'gpt-pro', clientId: 'openai', cli: {} }), undefined);
});

test('skips complete native wrappers, but never guesses past a clipped wrapper', () => {
  assert.equal(
    humanSessionFirstLine(
      '<runtime-routing-context>\nprivate routing\n</runtime-routing-context>\n\n---\n\n请修一下列表',
    ),
    '请修一下列表',
  );
  assert.equal(humanSessionFirstLine('<runtime-routing-context> This is owner-authorized routing data…'), '');
  assert.equal(
    humanSessionFirstLine(
      '# Files mentioned by the user:\n## codex-clipboard-a\n/tmp/image.png\n\n## My request for Codex:\n修复手机面板\n细节',
    ),
    '修复手机面板',
  );
  assert.equal(humanSessionFirstLine('# Files mentioned by the user: ## codex-clipboard-a…'), '');
  assert.equal(humanSessionFirstLine('> L0 Staging Layer (ADR-038)\n\n身份提示…'), '');
});
