import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);
const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/context/ContextEpochOwner.js');
const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');

const CAT_ID = 'gemini38';
const USER_ID = 'owner';
const THREAD_ID = 'thread-f325-cold-replacement';

function buildL0({ rosterRow, capsuleText, restricted }) {
  return [
    '## 1. 身份与伙伴声明',
    '',
    '你是 暹罗猫/烁烁（暹罗猫 Gemini 3.8 Flash）。',
    ...(restricted ? ['', '**硬限制**：禁止写代码。被 @ 做这类任务时请 push back。'] : []),
    '## 主人画像',
    '',
    capsuleText,
    '',
    '共享事实: cat-cafe-profile://corpus/current（cat_cafe_read_profile layer=corpus 按需读）',
    '读源走本轮绑定的 Clowder AI 连接；勿用独立 App 的同名工具替代。',
    '',
    '你不是一个孤立的工具——你是协作团队的一员。',
    '',
    '## 队友名册',
    '| 猫猫 | @mention · 当前模型 | 路由边界 |',
    '|------|---------|------|',
    rosterRow,
    '',
    '---',
    '',
    '## 3. 家规',
    'Rule 0: 边界内保留判断力。',
  ].join('\n');
}

describe('F325 AGY Native session continuity & cold-replacement history backfill', () => {
  test('hot-resumes across roster/capsule churn and backfills read-only thread history on native_binding_changed seal without rewinding cursors', async () => {
    const base = mkdtempSync(join(tmpdir(), 'f325-cold-history-'));
    const workspace = join(base, 'workspace');
    const dataDir = join(base, 'data');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    try {
      let currentL0 = buildL0({
        rosterRow: '| 布偶猫 Dot | @dot · claude-opus-5-5-high | — |',
        capsuleText: '默认中文。',
        restricted: true,
      });
      let nextReplyText = '';
      let freshConversationCounter = 0;
      const launches = [];
      const stdinPayloads = [];

      const service = new AgyNativeAgentService({
        catId: CAT_ID,
        profile: {
          enabled: true,
          profileId: CAT_ID,
          homeRoot: join(base, 'profiles'),
          model: 'gemini-3.8-flash-high',
          trustedWorkspaces: [workspace],
        },
        command: '/usr/bin/true',
        l0CompilerFn: async () => currentL0,
      });
      const actualInvokeWithPreflight = service.invokeWithContinuityPreflight.bind(service);
      service.invokeWithContinuityPreflight = (preflight, options) =>
        actualInvokeWithPreflight(preflight, {
          ...options,
          spawnCliOverride: async function* (launch) {
            launches.push(launch);
            launch.onStdinReady((rawStdin) => {
              const decoded = JSON.parse(rawStdin.trim());
              const textPart = Array.isArray(decoded.message?.content)
                ? decoded.message.content[0]?.text
                : decoded.message?.content;
              stdinPayloads.push(typeof textPart === 'string' ? textPart : rawStdin);
            });
            const resumeIdx = launch.args.indexOf('--conversation');
            const convId = resumeIdx >= 0 ? launch.args[resumeIdx + 1] : `native-conv-${++freshConversationCounter}`;
            yield {
              event: 'init',
              conversation_id: convId,
              init: {
                agent: launch.args[launch.args.indexOf('--agent') + 1],
                cwd: launch.cwd,
                model: 'gemini-3.8-flash-high',
                permission_mode: 'request-review',
                tools: [],
              },
            };
            yield {
              event: 'result',
              result: {
                conversation_id: convId,
                status: 'SUCCESS',
                response: `${nextReplyText}\n\n[烁烁/gemini-3.8-flash-high🐾]`,
                num_turns: 1,
              },
            };
          },
        });

      const messageStore = new MessageStore();
      const deliveryCursorStore = new DeliveryCursorStore();
      const sessionChainStore = new SessionChainStore();
      const transcriptWriter = new TranscriptWriter({ dataDir });
      const sessionSealer = new SessionSealer(sessionChainStore, transcriptWriter);
      const contextEpochOwner = new ContextEpochOwner(new InMemoryContextEpochStore());
      let activeSessionId = null;
      let invSeq = 0;

      const deps = {
        services: { [CAT_ID]: service },
        invocationDeps: {
          registry: {
            create: () => ({ invocationId: `inv-f325-${++invSeq}`, callbackToken: `tok-f325-${invSeq}` }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: {
            get: async () => activeSessionId,
            store: async (_u, _c, _t, id) => {
              activeSessionId = id;
            },
            delete: async () => {
              activeSessionId = null;
            },
            resolveWorkingDirectory: () => workspace,
          },
          sessionChainStore,
          sessionSealer,
          transcriptWriter,
          contextEpochOwner,
          threadStore: {
            get: async () => ({
              id: THREAD_ID,
              title: 'F325 新猫会话连续性验证',
              userId: USER_ID,
              createdBy: USER_ID,
              projectPath: workspace,
              createdAt: 1_794_300_000_000,
            }),
            getThreadMemory: async () => null,
            updateParticipantActivity: async () => {},
            consumeMentionRoutingFeedback: async () => null,
          },
          apiUrl: 'http://127.0.0.1:3004',
        },
        messageStore,
        deliveryCursorStore,
      };

      const runUserTurn = async (text, reply, timestamp) => {
        nextReplyText = reply;
        const userMsg = await messageStore.append(
          canonicalTestMessageInput({
            threadId: THREAD_ID,
            userId: USER_ID,
            catId: null,
            content: text,
            mentions: [CAT_ID],
            timestamp,
          }),
        );
        const exposedBatches = [];
        const events = [];
        for await (const ev of routeSerial(deps, [CAT_ID], text, USER_ID, THREAD_ID, {
          currentUserMessageId: userMsg.id,
          nowMs: timestamp,
          onPromptMessagesExposed: async (exposure) => {
            exposedBatches.push(exposure.messageIds);
          },
        })) {
          events.push(ev);
        }
        return { userMsg, events, exposedBatches };
      };

      const t0 = 1_794_340_000_000;

      // Turn 1: Initial cold start -> Session #1 (native-conv-1)
      const turn1 = await runUserTurn('Q1: 先看看 F325 的验收口径', 'A1: 已读取 F325 验收口径，准备下一步', t0);
      assert.equal(turn1.events.find((e) => e.type === 'error')?.error, undefined, JSON.stringify(turn1.events));
      assert.equal(launches.length, 1);
      assert.equal(activeSessionId, 'native-conv-1');
      assert.deepEqual(turn1.exposedBatches, [[turn1.userMsg.id]]);

      // Turn 2 (2 hours later): Teammate @dot removed + owner capsule edited -> MUST hot-resume Session #1!
      currentL0 = buildL0({
        rosterRow: '| 缅因猫 Sol | @codex61-sol · gpt-6.1-sol | — |',
        capsuleText: '默认中文；最近在验收新猫。',
        restricted: true,
      });
      const turn2 = await runUserTurn('Q2: 帮我看下目录结构', 'A2: 目录结构已核对完毕', t0 + 2 * 60 * 60 * 1000);
      assert.equal(launches.length, 2, 'roster/capsule update must resume hot without sealing');
      assert.equal(activeSessionId, 'native-conv-1');
      assert.deepEqual(launches[1].args.slice(-2), ['--conversation', 'native-conv-1']);
      assert.match(stdinPayloads[1], /"contextMode":"hot"/);
      assert.match(stdinPayloads[1], /"transition":"resumed"/);
      assert.equal(
        turn2.events.some((e) => e.type === 'system_info' && e.content?.includes('session_seal_requested')),
        false,
      );

      const cursorBeforeTurn3 = await deliveryCursorStore.getCursor(USER_ID, CAT_ID, THREAD_ID);
      assert.ok(cursorBeforeTurn3, 'delivery cursor recorded before Turn 3');

      // Turn 3 (4 hours after Turn 2): Own restriction unlocked + 1 non-trigger unread note -> seals Session #1 & starts Session #2 with backfilled history!
      const unreadNote = await messageStore.append(
        canonicalTestMessageInput({
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: null,
          content: 'NOTE3: 顺便别碰 6399',
          mentions: [],
          timestamp: t0 + 6 * 60 * 60 * 1000 - 10_000,
        }),
      );
      currentL0 = buildL0({
        rosterRow: '| 缅因猫 Sol | @codex61-sol · gpt-6.1-sol | — |',
        capsuleText: '默认中文；最近在验收新猫。',
        restricted: false,
      });
      const turn3 = await runUserTurn(
        'Q3: 现在开工位把三处问题修掉',
        'A3: 已结合前两轮结论开始修复',
        t0 + 6 * 60 * 60 * 1000,
      );
      assert.equal(launches.length, 3, 'mismatched resume rejected pre-spawn; replacement Session #2 launched once');
      assert.equal(activeSessionId, 'native-conv-2');

      const chain = await sessionChainStore.getChain(CAT_ID, THREAD_ID, USER_ID);
      assert.equal(chain.length, 2);
      assert.equal(chain[0].status, 'sealed');
      assert.equal(chain[0].sealReason, 'native_binding_changed');
      assert.equal(chain[1].status, 'active');
      assert.equal(chain[1].cliSessionId, 'native-conv-2');

      // Replacement prompt must report fresh/resume_rejected (NOT no_prior_session) and include Q1, A1, Q2, A2 + NOTE3 + Q3!
      const replacementPrompt = stdinPayloads[2];
      assert.match(replacementPrompt, /"contextEpoch":2/);
      assert.match(replacementPrompt, /"contextMode":"cold"/);
      assert.match(replacementPrompt, /"transition":"fresh"/);
      assert.match(replacementPrompt, /"reason":"resume_rejected"/);
      assert.match(replacementPrompt, /"deltaSize":"small"/);
      assert.match(
        replacementPrompt,
        /0 条已摘要, 6 条详细/,
        'multi-hour pause must not dump backfilled history into omitted',
      );
      for (const expectedTurnText of [
        'Q1: 先看看 F325 的验收口径',
        'A1: 已读取 F325 验收口径，准备下一步',
        'Q2: 帮我看下目录结构',
        'A2: 目录结构已核对完毕',
        'NOTE3: 顺便别碰 6399',
        'Q3: 现在开工位把三处问题修掉',
      ]) {
        assert.ok(
          replacementPrompt.includes(expectedTurnText),
          `replacement prompt missing expected history "${expectedTurnText}":\n${replacementPrompt}`,
        );
      }

      // Historical messages must NOT be re-exposed to queue adoption (only unreadNote + Q3!) or rewind delivery cursors
      assert.deepEqual(turn3.exposedBatches, [[unreadNote.id, turn3.userMsg.id]]);
      const cursorAfterTurn3 = await deliveryCursorStore.getCursor(USER_ID, CAT_ID, THREAD_ID);
      assert.notEqual(cursorAfterTurn3, cursorBeforeTurn3);

      // Visible system notice persisted with TTL=0
      const threadMessagesAfterTurn3 = await messageStore.getByThread(THREAD_ID, 50);
      const sealNotices = threadMessagesAfterTurn3.filter((m) => m.source?.connector === 'native-session-seal');
      assert.equal(sealNotices.length, 1);
      assert.equal(sealNotices[0].ttlSeconds, undefined);
      assert.match(sealNotices[0].content, /原生配置已更新，会话 #1 已封存；正在带上历史继续/);

      // Turn 4 (5 minutes later): Hot-resumes Session #2 and excludes display-only seal notice from prompt
      const turn4 = await runUserTurn(
        'Q4: 补跑一下回归测试',
        'A4: 回归测试全部通过',
        t0 + 6 * 60 * 60 * 1000 + 5 * 60 * 1000,
      );
      assert.equal(launches.length, 4);
      assert.deepEqual(launches[3].args.slice(-2), ['--conversation', 'native-conv-2']);
      assert.match(stdinPayloads[3], /"contextMode":"hot"/);
      assert.equal(stdinPayloads[3].includes('原生配置已更新'), false);
      assert.deepEqual(turn4.exposedBatches, [[turn4.userMsg.id]]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('on native_binding_changed cold replacement, settles with resume_rejected and backfills prior Q&A instead of waking with amnesia', async () => {
    const base = mkdtempSync(join(tmpdir(), 'f325-amnesia-red-'));
    const workspace = join(base, 'workspace');
    const dataDir = join(base, 'data');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    try {
      let currentL0 = buildL0({
        rosterRow: '| 缅因猫 Sol | @codex61-sol · gpt-6.1-sol | — |',
        capsuleText: '默认中文。',
        restricted: true,
      });
      let nextReplyText = '';
      let freshCounter = 0;
      const stdinPayloads = [];

      const service = new AgyNativeAgentService({
        catId: CAT_ID,
        profile: {
          enabled: true,
          profileId: CAT_ID,
          homeRoot: join(base, 'profiles'),
          model: 'gemini-3.8-flash-high',
          trustedWorkspaces: [workspace],
        },
        command: '/usr/bin/true',
        l0CompilerFn: async () => currentL0,
      });
      const actualInvokeWithPreflight = service.invokeWithContinuityPreflight.bind(service);
      service.invokeWithContinuityPreflight = (preflight, options) =>
        actualInvokeWithPreflight(preflight, {
          ...options,
          spawnCliOverride: async function* (launch) {
            launch.onStdinReady((rawStdin) => {
              const decoded = JSON.parse(rawStdin.trim());
              const textPart = Array.isArray(decoded.message?.content)
                ? decoded.message.content[0]?.text
                : decoded.message?.content;
              stdinPayloads.push(typeof textPart === 'string' ? textPart : rawStdin);
            });
            const resumeIdx = launch.args.indexOf('--conversation');
            const convId = resumeIdx >= 0 ? launch.args[resumeIdx + 1] : `conv-${++freshCounter}`;
            yield {
              event: 'init',
              conversation_id: convId,
              init: {
                agent: launch.args[launch.args.indexOf('--agent') + 1],
                cwd: launch.cwd,
                model: 'gemini-3.8-flash-high',
                permission_mode: 'request-review',
                tools: [],
              },
            };
            yield {
              event: 'result',
              result: {
                conversation_id: convId,
                status: 'SUCCESS',
                response: `${nextReplyText}\n\n[烁烁/gemini-3.8-flash-high🐾]`,
                num_turns: 1,
              },
            };
          },
        });

      const messageStore = new MessageStore();
      const deliveryCursorStore = new DeliveryCursorStore();
      const sessionChainStore = new SessionChainStore();
      const transcriptWriter = new TranscriptWriter({ dataDir });
      const sessionSealer = new SessionSealer(sessionChainStore, transcriptWriter);
      const contextEpochOwner = new ContextEpochOwner(new InMemoryContextEpochStore());
      let activeSessionId = null;
      let invSeq = 0;

      const deps = {
        services: { [CAT_ID]: service },
        invocationDeps: {
          registry: {
            create: () => ({ invocationId: `inv-amnesia-${++invSeq}`, callbackToken: `tok-${invSeq}` }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: {
            get: async () => activeSessionId,
            store: async (_u, _c, _t, id) => {
              activeSessionId = id;
            },
            delete: async () => {
              activeSessionId = null;
            },
            resolveWorkingDirectory: () => workspace,
          },
          sessionChainStore,
          sessionSealer,
          transcriptWriter,
          contextEpochOwner,
          threadStore: {
            get: async () => ({
              id: THREAD_ID,
              title: 'F325 失忆复现',
              userId: USER_ID,
              createdBy: USER_ID,
              projectPath: workspace,
              createdAt: 1_794_300_000_000,
            }),
            getThreadMemory: async () => null,
            updateParticipantActivity: async () => {},
            consumeMentionRoutingFeedback: async () => null,
          },
          apiUrl: 'http://127.0.0.1:3004',
        },
        messageStore,
        deliveryCursorStore,
      };

      const t0 = 1_794_340_000_000;
      nextReplyText = 'A1: 先完成方案评估';
      const q1 = await messageStore.append(
        canonicalTestMessageInput({
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: null,
          content: 'Q1: 帮我评估一下猫爬架三处缺陷',
          mentions: [CAT_ID],
          timestamp: t0,
        }),
      );
      for await (const _ of routeSerial(deps, [CAT_ID], q1.content, USER_ID, THREAD_ID, {
        currentUserMessageId: q1.id,
        nowMs: t0,
      })) {
        // drain
      }

      // Unlock own restriction 3 hours later -> triggers native_binding_changed cold replacement
      currentL0 = buildL0({
        rosterRow: '| 缅因猫 Sol | @codex61-sol · gpt-6.1-sol | — |',
        capsuleText: '默认中文。',
        restricted: false,
      });
      nextReplyText = 'A2: 收到，立刻开工';
      const q2 = await messageStore.append(
        canonicalTestMessageInput({
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: null,
          content: 'Q2: 可以，开工位修掉',
          mentions: [CAT_ID],
          timestamp: t0 + 3 * 60 * 60 * 1000,
        }),
      );
      for await (const _ of routeSerial(deps, [CAT_ID], q2.content, USER_ID, THREAD_ID, {
        currentUserMessageId: q2.id,
        nowMs: t0 + 3 * 60 * 60 * 1000,
      })) {
        // drain
      }

      assert.equal(stdinPayloads.length, 2);
      assert.match(stdinPayloads[1], /"reason":"resume_rejected"/);
      assert.ok(stdinPayloads[1].includes('Q1: 帮我评估一下猫爬架三处缺陷'), stdinPayloads[1]);
      assert.ok(stdinPayloads[1].includes('A1: 先完成方案评估'), stdinPayloads[1]);
      assert.ok(stdinPayloads[1].includes('Q2: 可以，开工位修掉'), stdinPayloads[1]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
