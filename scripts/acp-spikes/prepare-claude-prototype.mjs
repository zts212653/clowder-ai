import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { patchClaudeQueuedCancel } from './claude-cancel-patch.mjs';
import { patchClaudeIngressFault } from './claude-ingress-fault-patch.mjs';

const source = resolve(process.argv[2] ?? '../../.research-20261012-client-comparison/claude-agent-acp');
const target = resolve(
  '.cat-cafe/tmp/acp-prototypes',
  process.argv.includes('--fault-ingress') ? 'claude-ingress-fault' : 'claude',
);
const pin = 'd0aafb1ca26427285ffaeac8d8a4452fff28e9c3';
if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pin)
  throw new Error('Claude upstream pin mismatch');
await mkdir(target, { recursive: true });
for (const file of ['src', 'package.json', 'package-lock.json', 'tsconfig.json'])
  await cp(join(source, file), join(target, file), { recursive: true });
await cp(
  'scripts/acp-spikes/claude-next-boundary.test.template.ts',
  join(target, 'src/tests/clowder-next-boundary.test.ts'),
);
const steeringTest = join(target, 'src/tests/acp-agent.test.ts');
let tests = await readFile(steeringTest, 'utf8');
const testAnchor = '  it("rejects when the session is unknown", async () => {';
if (!tests.includes(testAnchor)) throw new Error('Claude steering regression anchor missing');
tests = tests.replace(
  testAnchor,
  `${await readFile('scripts/acp-spikes/claude-followup-regression.snippet.txt', 'utf8')}\n${await readFile('scripts/acp-spikes/claude-cancel-regression.snippet.txt', 'utf8')}\n${testAnchor}`,
);
await writeFile(steeringTest, tests);
if (process.argv.includes('--patch-next')) {
  const file = join(target, 'src/acp-agent.ts');
  let text = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  text = text.replace(
    '    idleBehavior?: "promptRequired";',
    '    idleBehavior?: "promptRequired";\n    delivery?: "next";',
  );
  text = text.replace(
    'userMessage.priority = STEER_PRIORITY;',
    'userMessage.priority = params._meta?.steering?.delivery === "next" ? "next" : STEER_PRIORITY;',
  );
  text = text.replace('| { outcome: "injected" }', '| { outcome: "injected"; nativeInputUuid?: string }');
  text = text.replace(
    '    return { outcome: "injected" };',
    '    return params._meta?.steering?.delivery === "next" ? { outcome: "injected", nativeInputUuid: steeredUuid } : { outcome: "injected" };',
  );
  const anchor = '    .onRequest<SteerRequest, SteerResponse>(STEER_METHOD, { parse: parseSteerRequest }, (ctx) =>';
  if (!text.includes(anchor)) throw new Error('Claude ACP wire route anchor missing');
  text = text.replace(
    anchor,
    `    .onRequest<SteerRequest, SteerResponse>("_clowder/v1/notice", { parse: parseSteerRequest }, (ctx) =>
      agent.steer({ ...ctx.params, _meta: { steering: { delivery: "next", idleBehavior: "promptRequired" } } }),
    )
${anchor}`,
  );
  const metaAnchor = '        ...airSessionFailureCapabilityMeta(AGENT_FILE_CHANGE_REPORT_CAPABILITY),';
  if (!text.includes(metaAnchor)) throw new Error('Claude capability anchor missing');
  text = text.replace(
    metaAnchor,
    `${metaAnchor}
        _clowder: { noticeV1: { prototype: true, version: 1, method: "_clowder/v1/notice", delivery: "next", idleBehavior: "promptRequired" } },`,
  );
  await writeFile(file, text);
}
if (process.argv.includes('--patch-followup')) {
  const file = join(target, 'src/acp-agent.ts');
  let text = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  const field = '  promptUuid: string;';
  text = text.replace(
    field,
    `${field}
  clowderPrimaryModelIds?: Set<string>;
  clowderNoticeUuids?: Set<string>;
  clowderPrimaryRootToolIds?: Set<string>;
  clowderOwnedFollowupRuns?: Set<string>;`,
  );
  const noticeUuid = '    userMessage.uuid = steeredUuid;';
  if (!text.includes(noticeUuid)) throw new Error('Claude notice UUID anchor missing');
  text = text.replace(
    noticeUuid,
    `${noticeUuid}\n    (turnInFlight.clowderNoticeUuids ??= new Set()).add(steeredUuid);`,
  );
  const ownershipAnchor = '        // CLIs 2.1.206+ (capability msg_lifecycle_v1)';
  if (!text.includes(ownershipAnchor)) throw new Error('Claude consumer ownership anchor missing');
  text = text.replace(
    ownershipAnchor,
    `        // Native command UUID -> model message -> tool -> followup run.
        // Late old tool blocks must not adopt whichever turn is active.
        const clowderTurn = session.activeTurn;
        const clowderOrigin = (message as unknown as { origin?: { kind?: string } }).origin;
        if (clowderTurn && !clowderTurn.settled) {
          if (message.type === "assistant" && message.parent_tool_use_id === null &&
              (!clowderOrigin?.kind || clowderOrigin.kind === "human")) {
            const frame = message as unknown as Record<string, unknown>;
            const commandUuids = [frame.user_message_uuid, ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : [])];
            if (typeof message.message.id === "string" && message.message.id.length > 0 && commandUuids.some(uuid => typeof uuid === "string" &&
                (uuid === clowderTurn.promptUuid || clowderTurn.clowderNoticeUuids?.has(uuid))))
              (clowderTurn.clowderPrimaryModelIds ??= new Set()).add(message.message.id);
            if (clowderTurn.clowderPrimaryModelIds?.has(message.message.id))
              for (const block of message.message.content) if (block.type === "tool_use")
                (clowderTurn.clowderPrimaryRootToolIds ??= new Set()).add(block.id);
          }
          const native = message as unknown as Record<string, unknown>;
          if (message.type === "system" && message.subtype === "task_notification" &&
              typeof native.tool_use_id === "string" && typeof native.run_id === "string" &&
              clowderTurn.clowderPrimaryRootToolIds?.has(native.tool_use_id))
            (clowderTurn.clowderOwnedFollowupRuns ??= new Set()).add(native.run_id);
        }
${ownershipAnchor}`,
  );
  const debt = '              const owesTrailingIdle = isAutonomousResult || !isSteering(session.activeTurn);';
  if (!text.includes(debt)) throw new Error('Claude idle debt anchor missing');
  text = text.replace(
    debt,
    `              const clowderRun = (message.origin as unknown as { runId?: string } | undefined)?.runId;
              const clowderOwnedSteerFollowup = isSteering(session.activeTurn) &&
                message.origin?.kind === "task-notification" && typeof clowderRun === "string" &&
                session.activeTurn.clowderOwnedFollowupRuns?.has(clowderRun) === true;
              // Its idle spans this same primary/steer. Foreign autonomous
              // results retain their debt; usage/result ownership stays native.
              const owesTrailingIdle = (isAutonomousResult && !clowderOwnedSteerFollowup) || !isSteering(session.activeTurn);`,
  );
  await writeFile(file, text);
}
if (process.argv.includes('--patch-cancel-queued')) {
  if (!process.argv.includes('--patch-next')) throw new Error('Queued cancel requires the narrow next patch');
  await cp('scripts/acp-spikes/claude-native-cancel.ts', join(target, 'src/ClowderNativeCancel.ts'));
  const file = join(target, 'src/acp-agent.ts');
  await writeFile(file, patchClaudeQueuedCancel(await readFile(file, 'utf8')));
}
if (process.argv.includes('--fault-ingress')) {
  if (!process.argv.includes('--patch-cancel-queued')) throw new Error('Ingress fault requires queued-cancel patch');
  const file = join(target, 'src/acp-agent.ts');
  await writeFile(file, patchClaudeIngressFault(await readFile(file, 'utf8')));
  const dependencies = resolve('.cat-cafe/tmp/acp-prototypes/claude/node_modules');
  try {
    await symlink(dependencies, join(target, 'node_modules'), 'junction');
  } catch (error) {
    if (error.code !== 'EEXIST' || (await realpath(join(target, 'node_modules'))) !== (await realpath(dependencies)))
      throw error;
  }
}
console.log(
  JSON.stringify({
    source,
    target,
    upstream: pin,
    patch: process.argv.includes('--patch-next')
      ? 'next-only backport + notice test route + UUID receipt; full human interaction verification pending'
      : 'unpatched baseline',
    nativeVerification: 'pending',
    ownedFollowupPatch: process.argv.includes('--patch-followup'),
    queuedCancelPatch: process.argv.includes('--patch-cancel-queued'),
    productionEnabled: false,
  }),
);
