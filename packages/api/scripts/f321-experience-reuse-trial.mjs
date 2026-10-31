// One-off adoption comparison; no scoring loop, no privileged production writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileL0 } from '../../../scripts/compile-system-prompt-l0.mjs';
import {
  formatNavigationHeader,
  summarizeActiveTasks,
} from '../dist/domains/cats/services/agents/routing/navigation-context.js';
import { estimateTokens } from '../dist/utils/token-counter.js';
import { experienceCases as cases } from './f321-experience-cases.mjs';
import { evidenceItems, runConsumer } from './f321-experience-consumer.mjs';
import { createExperienceEnvironment } from './f321-experience-environment.mjs';
import { prepareExperienceSources } from './f321-experience-sources.mjs';
import { prepareUnapprovedBatch } from './f321-release-source.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.argv[2] ?? '/tmp/f321-experience-results');
const selected = process.argv[3];
const root = mkdtempSync(join(tmpdir(), 'f321-experience-'));
mkdirSync(out, { recursive: true });
const model = 'gpt-6.1-sol';
const effort = 'low';
const genericCheck =
  '执行当前任务前，先判断哪些前提依赖既有个人或项目约定；按任务自主查找相关依据并回读当前原文，确认主体、项目、适用条件与版本后再采用。区分历史经过、当前知识和本批授权/进度；资料不足不编造，检索摘要不授予操作权限。处理后识别本次新增的可复用知识，交回原合法归属方，不另造竞争真相。无此依赖的任务直接做。';

let env;
try {
  // Compiler and real registry identity, isolated profile directory; same frozen native L0 in both arms.
  const identityTemplate = resolve(process.argv[4] ?? join(repoRoot, '../cat-cafe-runtime/cat-template.json'));
  const identityRoot = join(root, 'native-config');
  mkdirSync(join(identityRoot, '.cat-cafe'), { recursive: true });
  cpSync(identityTemplate, join(identityRoot, 'cat-template.json'));
  cpSync(
    join(dirname(identityTemplate), '.cat-cafe/cat-catalog.json'),
    join(identityRoot, '.cat-cafe/cat-catalog.json'),
  );
  process.env.CAT_TEMPLATE_PATH = join(identityRoot, 'cat-template.json');
  const compiledL0 = await compileL0({
    catId: 'codex61-sol',
    runtimeModel: model,
    profileDir: join(root, 'empty-profile'),
  });
  const baselineL0 = compiledL0;
  const frozenFiles = [
    'assets/prompt-templates/l6-capability-wakeup.md',
    'packages/mcp-server/governance/mcp-surface-baseline.json',
    'packages/api/scripts/f321-experience-reuse-trial.mjs',
    'packages/api/scripts/f321-experience-environment.mjs',
    'packages/api/scripts/f321-experience-sources.mjs',
    'packages/api/scripts/f321-release-source.mjs',
    'packages/api/scripts/f321-experience-consumer.mjs',
    'packages/api/scripts/f321-experience-cases.mjs',
    'packages/mcp-server/test/fixtures/f321-experience-tools-server.mjs',
    'cat-cafe-skills/memory-navigation/SKILL.md',
    'cat-cafe-skills/refs/memory-routing-partial.md',
    'packages/api/src/routes/evidence.ts',
    'packages/api/src/domains/memory/KnowledgeResolver.ts',
    'packages/api/src/domains/cats/services/agents/routing/navigation-context.ts',
    'packages/mcp-server/src/tools/callback-tools.ts',
    'packages/mcp-server/src/tools/evidence-tools.ts',
    'packages/mcp-server/src/tools/graph-tools.ts',
    'packages/mcp-server/src/tools/file-tools.ts',
  ];
  const frozenBuild = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    files: Object.fromEntries(
      frozenFiles.map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(join(repoRoot, path)))
          .digest('hex'),
      ]),
    ),
    cases: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
  };
  env = await createExperienceEnvironment(repoRoot, root);
  const { bookPath, header, observation, release } = await prepareExperienceSources(env, out, {
    genericCheck,
    baselineL0,
    frozenBuild,
  });
  const reports = [];
  const skillRoot = join(repoRoot, 'cat-cafe-skills');
  for (const entry of cases.filter((item) => !selected || selected.split(',').some((key) => item.id.includes(key)))) {
    let mutation;
    if (entry.phase === 'profile-corrected') {
      mutation = await env.legalProfile(
        '当前更正约定：主体 codex61-sol，称呼改为「雾桥」，角色改为「独立搭档」。先前夜读搭子关系已取消，旧名字不再作为当前称呼。',
      );
    }
    if (entry.phase === 'profile-forgotten') {
      const { ProfileMemoryLifecycleStore } = await import(
        '../dist/domains/memory/profile/ProfileMemoryLifecycleStore.js'
      );
      const lifecycle = new ProfileMemoryLifecycleStore({ db: env.store.getDb(), repository: env.repository });
      const revision = env.repository.readPrimer(env.repository.scope('trial-owner', 'codex61-sol')).revision;
      mutation = lifecycle.hardForget({
        ownerUserId: 'trial-owner',
        memoryId: `primer:${env.repository.scope('trial-owner', 'codex61-sol').relationshipKey}`,
        command: { action: 'hard_forget', requestId: 'trial-forget', expectedRevision: revision, confirmed: true },
      });
      assert.equal(mutation.outcome, 'forgotten');
    }
    if (entry.phase === 'knowledge-corrected') {
      const correction = env.append(
        '原项目经验更正：当前隔离项目的 autoRebuild=false；修改原文后先由原索引owner作已授权增量更新并核来源revision，再查查询。',
      );
      mutation = await env.recordProject(
        bookPath,
        header +
          '当前更正：本项目隔离复验配置 autoRebuild=false。修改原文不会自行刷新该索引；先由原索引owner执行已授权增量更新并核当前来源revision，再测试查询。旧快照只有过去的观察，不能把只缩短query当作修复索引滞后的办法。对已确认覆盖且新鲜的索引，仍可改写查询；无新授权不修改外仓、库权限或生产配置。\n' +
          `\n更正来源：${env.sourceThreadId}#${correction.id}\n\n` +
          observation,
      );
    }
    const phaseNativeL0 = await compileL0({
      catId: 'codex61-sol',
      runtimeModel: model,
      profileDir: env.repository.profileDir('trial-owner'),
    });
    const primerSnapshot = env.repository.readPrimer(env.repository.scope('trial-owner', 'codex61-sol'));
    assert.equal(
      phaseNativeL0.includes('cat-cafe-profile://relationship/current'),
      Boolean(primerSnapshot),
      'legal writer and native compiler must share the real persona scope',
    );
    if (primerSnapshot)
      assert.equal(
        phaseNativeL0.includes(primerSnapshot.content),
        false,
        'native entry carries a pointer, not the private primer body',
      );
    const currentL6 = readFileSync(join(repoRoot, 'assets/prompt-templates/l6-capability-wakeup.md'), 'utf8').trim();
    const baselineL6 = execFileSync(
      'git',
      ['show', '4c6241c784f08d17ee4142ef1c318bbe1cc34c84:assets/prompt-templates/l6-capability-wakeup.md'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    assert.ok(phaseNativeL0.includes(currentL6));
    const phaseBaselineL0 = phaseNativeL0.replace(currentL6, baselineL6);
    if (process.env.F321_PREFLIGHT_ONLY === '1') {
      console.log(
        JSON.stringify({
          preflight: true,
          id: entry.id,
          scope: env.repository.scope('trial-owner', 'codex61-sol'),
          primer: primerSnapshot?.revision ?? null,
        }),
      );
      continue;
    }
    if (entry.phase === 'release-unapproved') mutation = await prepareUnapprovedBatch(env, release);
    const arms =
      process.env.F321_MATRIX === '1'
        ? entry.comparison
          ? ['A', 'B', 'C']
          : ['C']
        : process.env.F321_CANDIDATE_ONLY === '1'
          ? ['C']
          : ['A', 'B'];
    for (const arm of arms) {
      const auth = await env.registry.create('trial-owner', 'codex61-sol', env.consumerThreadId);
      const credentials = join(root, 'reader-credentials.json');
      writeFileSync(
        credentials,
        JSON.stringify({
          CAT_CAFE_API_URL: env.address,
          CAT_CAFE_INVOCATION_ID: auth.invocationId,
          CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
          CAT_CAFE_THREAD_ID: env.consumerThreadId,
          CAT_CAFE_DATA_DIR: join(env.docs, '.reader-data'),
          ALLOWED_WORKSPACE_DIRS: [env.project, env.docs, skillRoot].join(':'),
        }),
        { mode: 0o600 },
      );
      const cwd = entry.id === 'external' ? join(root, 'external-project') : env.project;
      mkdirSync(cwd, { recursive: true });
      const navigation = formatNavigationHeader({
        threadId: env.consumerThreadId,
        currentCatId: 'codex61-sol',
        baton: null,
        tasks: summarizeActiveTasks(env.tasks.listByThread(env.consumerThreadId)),
      });
      assert.ok(navigation.includes(release.task.title), 'trial must carry the normal active-Task navigation');
      assert.equal(
        navigation.includes(release.candidates[0].metadataPath),
        false,
        'navigation must not seed an answer path',
      );
      const developer =
        (arm === 'C' ? phaseNativeL0 : phaseBaselineL0) +
        '\n' +
        navigation +
        '\n本轮为隔离工作区的只读准备阶段；使用正常挂载的工具查资料并交付具体回答/产物，不得真实上传或改持久权限。原工具中未挂载的写操作不可用。' +
        (arm === 'B' ? `\n${genericCheck}` : '');
      const input = `当前项目：Clowder AI。当前猫：codex61-sol。\n${arm === 'C' ? (entry.heldoutQuery ?? entry.query) : entry.query}`;
      const args = [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '--json',
        '-m',
        model,
        '-s',
        'read-only',
        '-C',
        cwd,
        '-c',
        'approval_policy="never"',
        '-c',
        `developer_instructions=${JSON.stringify(developer)}`,
        '-c',
        `model_reasoning_effort="${effort}"`,
        '-c',
        'apps._default.enabled=false',
        '-c',
        'features.shell_tool=false',
        '-c',
        'mcp_servers.trial.command="node"',
        '-c',
        'mcp_servers.trial.default_tools_approval_mode="approve"',
        '-c',
        `mcp_servers.trial.cwd=${JSON.stringify(env.project)}`,
        '-c',
        `mcp_servers.trial.args=${JSON.stringify([join(repoRoot, 'packages/mcp-server/test/fixtures/f321-experience-tools-server.mjs'), credentials])}`,
        '--',
        '-',
      ];
      const childEnv = { ...process.env, RUST_LOG: 'error' };
      for (const key of Object.keys(childEnv)) if (key.startsWith('CAT_CAFE_')) delete childEnv[key];
      env.requests.length = 0;
      const start = performance.now();
      const result = await runConsumer(args, childEnv, input);
      const report = {
        id: entry.id,
        arm,
        inputUse:
          process.env.F321_INPUT_USE ??
          (arm === 'C' && entry.heldoutQuery
            ? 'frozen unseen natural task, not used to choose this code version'
            : arm === 'C'
              ? 'regression control'
              : 'paired diagnostic'),
        mutation,
        frozenBuild,
        navigation,
        retrievalHealth: env.retrievalHealth,
        sourceScope: env.repository.scope('trial-owner', 'codex61-sol'),
        primerRevision: primerSnapshot?.revision ?? null,
        nativeHasPrimerPointer: Boolean(primerSnapshot),
        requestedModel: model,
        effort,
        timeoutMs: 120000,
        elapsedMs: Math.round(performance.now() - start),
        promptTokensEstimated: estimateTokens(developer + input),
        promptSha256: createHash('sha256')
          .update(developer + input)
          .digest('hex'),
        input,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        requests: [...env.requests],
        items: evidenceItems(result.stdout),
        stderr: result.stderr,
      };
      reports.push(report);
      writeFileSync(join(out, 'consumer-results.json'), JSON.stringify(reports, null, 2));
      console.log(
        JSON.stringify({
          id: entry.id,
          arm,
          exitCode: result.exitCode,
          elapsedMs: report.elapsedMs,
          requests: report.requests.length,
        }),
      );
      const complete =
        !result.timedOut && result.exitCode === 0 && report.items.some((event) => event.type === 'turn.completed');
      const degraded = report.items.some(
        (event) =>
          event.item?.type === 'mcp_tool_call' &&
          event.item.tool === 'cat_cafe_search_evidence' &&
          event.item.result?.content?.some((block) => block.type === 'text' && block.text.startsWith('[DEGRADED]')),
      );
      const rawUnprepared = report.requests.some(
        (request) => request.url.includes('depth=raw') && !request.url.includes('scope=threads'),
      );
      report.validity = !complete
        ? 'runtime_incomplete'
        : degraded || rawUnprepared
          ? 'retrieval_environment_not_covered'
          : 'completed';
      writeFileSync(join(out, 'consumer-results.json'), JSON.stringify(reports, null, 2));
      if (!complete)
        console.warn(`Incomplete consumer ${entry.id}/${arm}; retained, not scored as a product failure or pass`);
    }
  }
} finally {
  if (env) await env.close();
  rmSync(root, { recursive: true, force: true });
}
