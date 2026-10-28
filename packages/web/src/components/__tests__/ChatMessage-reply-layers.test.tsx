import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { resetMessageDisclosureStateForTest } from '../message-disclosure-state';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  tool,
  toolResult,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

describe('F322 B §1.16 — a cat reply in three layers (new shell only)', () => {
  let harness: ReplyLayersHarness;

  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);

  beforeEach(() => {
    harness = new ReplyLayersHarness();
  });

  afterEach(() => harness.dispose());

  const render = (message: ChatMessageData) => harness.render(message);
  const q = (testId: string) => harness.q(testId);
  const click = (testId: string) => harness.click(testId);

  it('keeps a recovered startup in Activity rather than adding system copy to the cat reply', () => {
    harness.enableV2();
    render(
      streamReply({
        catId: 'codex-astra',
        toolEvents: [],
        extra: {
          startupRecovery: {
            invocationId: 'turn-1',
            stage: 'ready',
            sequence: 6,
            attempt: 3,
            maxAttempts: 6,
            startedAt: 1,
            deadlineAt: 120_001,
            updatedAt: 7_001,
          },
        },
      }),
    );
    expect(harness.container.textContent).not.toContain('账号确认已恢复');
    click('reply-record-toggle');
    expect(q('reply-record')?.textContent).toContain('账号确认已恢复，尝试 3 次');
  });

  describe('classic is untouched', () => {
    it('a streamed reply still lives in the CLI block, with the metadata line, the name-row anchor and no layers', () => {
      render(streamReply());

      expect(q('reply-layers')).toBeNull();
      expect(q('reply-last-line')).toBeNull();
      expect(harness.container.textContent).toContain('CLI Output');
      expect(harness.container.querySelector('[data-invocation-anchor]')).not.toBeNull();
      expect(q('message-metadata')).not.toBeNull();
      // the spoken text is inside the CLI block's body only when it is opened; it is not drawn as body text
      expect(
        harness.container.querySelector(
          '[data-testid="message-bubble"] .markdown-body, [data-testid="message-bubble"] p',
        ),
      ).toBeNull();
    });

    it('keeps retired routing protocol rows out of the classic timeline', () => {
      const reply = streamReply();
      const routing: ChatMessageData = {
        id: 'route-1',
        type: 'system',
        content: '布偶猫(Opus) → 缅因猫 Astra(gpt-6-astra)',
        timestamp: reply.timestamp + 1,
        extra: {
          systemKind: 'a2a_routing',
          a2aRouting: {
            fromCatId: 'opus',
            targetCatId: 'codex-astra',
            invocationId: 'parent-1',
          },
        },
      };

      harness.renderTimeline([reply, routing]);

      expect(harness.container.querySelector('[data-message-id="route-1"]')).toBeNull();
      expect(q('reply-handoff')).toBeNull();
    });
  });

  describe('v2', () => {
    beforeEach(() => harness.enableV2());

    it('layer 1: what the cat said is body text under the nameplate, with no CLI block around it', () => {
      render(streamReply());

      expect(harness.container.textContent).not.toContain('CLI Output');
      expect(q('cli-output-body')).toBeNull();
      expect(q('message-bubble')?.textContent).toContain('改好了登录页，截图见下。');
    });

    it('the body reads at the reading-column size: 15px text on a 1.7 line, for paragraphs and list items', () => {
      render(streamReply());

      const markdown = q('message-bubble')?.querySelector('.markdown-content');
      expect(markdown?.className).toContain('[&.markdown-content]:text-reading');
      expect(markdown?.className).toContain('[&_p]:leading-[inherit]');
      expect(markdown?.className).toContain('[&_li]:leading-[inherit]');
    });

    it('layer 3: the last line counts the tool calls and says how long, then the trajectory; the record is closed', () => {
      render(streamReply());

      const line = q('reply-last-line');
      expect(line?.textContent).toContain('2 次工具调用');
      expect(line?.textContent).toContain('6 分 42 秒');
      expect(line?.textContent).toContain('轨迹');
      expect(q('reply-status')).toBeNull();
      expect(q('reply-record')).toBeNull();
      expect(q('message-metadata')).toBeNull();
    });

    it('S4 shows the completed turn recall total from the same recall tool events, never while it is running', () => {
      const memoryTool = tool(
        'memory-1',
        'mcp__cat_cafe_memory__cat_cafe_search_evidence',
        JSON.stringify({ query: 'F322' }),
      );
      render(streamReply({ toolEvents: [memoryTool, toolResult('memory-1', 'Found 1 result(s):\n\nF322')] }));
      expect(q('reply-recall')?.textContent).toBe('召回 1');

      render(streamReply({ isStreaming: true, toolEvents: [memoryTool] }));
      expect(q('reply-recall')).toBeNull();
    });

    it('S4 opens the canonical memory Workspace at this turn and puts the shared breakdown first in the record', () => {
      const reply = streamReply({ id: 'recall-reply' });
      harness.renderTimeline(
        [reply],
        new Map([
          [
            reply.id,
            {
              invocationId: 'turn-1',
              catId: 'opus',
              status: 'ready' as const,
              events: [
                { id: 'search', query: 'F322', timestamp: 1, toolName: 'search_evidence' },
                { id: 'graph', query: 'F322', timestamp: 2, toolName: 'graph_resolve' },
                { id: 'delivery', query: '', timestamp: 3, source: 'push' as const },
              ],
            },
          ],
        ]),
      );

      expect(q('reply-recall')?.textContent).toBe('召回 3');
      click('reply-recall');
      expect(useChatStore.getState().rightPanelMode).toBe('workspace');
      expect(useChatStore.getState().rightPanelOpen).toBe(true);
      expect(useChatStore.getState().workspaceMode).toBe('recall');
      expect(new URL(window.location.href).searchParams.get('recallInv')).toBe('turn-1');

      click('reply-record-toggle');
      expect(q('reply-record')?.firstElementChild?.getAttribute('data-testid')).toBe('reply-record-recall');
      expect(q('reply-record-recall')?.textContent).toBe('检索 1 · 关系查询 1 · 递送 1');
    });

    it('S4 never invents zero when the recall source cannot be read', () => {
      const reply = streamReply({ id: 'recall-unavailable' });
      harness.renderTimeline(
        [reply],
        new Map([
          [
            reply.id,
            {
              invocationId: 'turn-1',
              catId: 'opus',
              status: 'unavailable' as const,
              events: [],
            },
          ],
        ]),
      );

      expect(q('reply-recall')).toBeNull();
      click('reply-record-toggle');
      expect(q('reply-record-recall')?.textContent).toBe('召回记录没读到');
      expect(q('reply-record-recall')?.textContent).not.toContain('0');
    });

    it('opening the record lists the tool calls and ends with the model and usage line; the toggle says what it does', () => {
      render(streamReply());

      expect(q('reply-record-toggle')?.getAttribute('aria-expanded')).toBe('false');
      click('reply-record-toggle');

      expect(q('reply-record-toggle')?.getAttribute('aria-expanded')).toBe('true');
      expect(q('reply-record-tool-t1')?.textContent).toContain('Bash pnpm test');
      expect(q('reply-record-tool-t2')?.textContent).toContain('Edit /app/login.tsx');
      expect(q('reply-record')?.querySelector('[data-testid="message-metadata"]')?.textContent).toContain(
        'claude-opus',
      );
      expect(q('reply-record')?.getAttribute('data-context-quote-source')).toBe('cli_output');
      click('reply-record-toggle');
      expect(q('reply-record')).toBeNull();
    });

    it('a tool row opens its detail on click', () => {
      render(streamReply());
      click('reply-record-toggle');
      expect(
        q('reply-record-tool-t1')
          ?.querySelector('[data-context-quote-segment-id="tool-label:t1"]')
          ?.getAttribute('data-context-quote-projection-version'),
      ).toBe('3');
      expect(q('reply-record')?.textContent).not.toContain('exit 0');

      harness.run(() => q('reply-record-tool-t1')?.querySelector('button')?.click());

      expect(q('reply-record-tool-t1')?.textContent).toContain('exit 0');
      expect(
        q('reply-record-tool-t1')
          ?.querySelector('[data-context-quote-segment-id="tool-detail:t1"]')
          ?.getAttribute('data-context-quote-projection-version'),
      ).toBe('3');
    });

    it('"其中 N 次出错" appears when a result was an error', () => {
      render(
        streamReply({
          toolEvents: [
            tool('t1', 'Bash'),
            toolResult('t1', 'boom', 'error'),
            tool('t2', 'Read'),
            toolResult('t2', 'ok'),
          ],
        }),
      );

      expect(q('reply-last-line')?.textContent).toContain('其中 1 次出错');
      click('reply-record-toggle');
      expect(q('reply-record-tool-t1')?.getAttribute('data-failed')).toBe('true');
    });

    it('the record starts open when the "执行记录默认" setting is expanded, and the choice on this reply wins afterwards', () => {
      useChatStore.setState({ globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'expanded' } });
      render(streamReply());
      expect(q('reply-record')).not.toBeNull();

      click('reply-record-toggle');
      expect(q('reply-record')).toBeNull();
    });

    it('the name row no longer carries the "运行中 / 轨迹" anchor: the trajectory is the last line', () => {
      render(streamReply());

      expect(harness.container.querySelector('[data-testid="message-header"] [data-invocation-anchor]')).toBeNull();
      expect(q('reply-trajectory')).not.toBeNull();
    });

    it("the trajectory button opens the Workspace on this reply's run", () => {
      useChatStore.setState({ rightPanelMode: 'chat', rightPanelOpen: false } as never);
      render(streamReply());

      click('reply-trajectory');

      expect(useChatStore.getState().rightPanelMode).toBe('workspace');
      expect(useChatStore.getState().rightPanelOpen).toBe(true);
    });

    describe('F319: the upstream answering with another model stays visible with the record closed', () => {
      const withMeta = (metadata: Record<string, unknown>) =>
        streamReply({
          metadata: { provider: 'openai', model: 'gpt-5.6-sol', usage: { durationMs: 60_000 }, ...metadata },
        });

      it('a different served model shows a warning fact on the last line, not only inside the record', () => {
        render(withMeta({ servedModel: 'gpt-6-sol' }));

        expect(q('reply-reroute')?.textContent).toBe('上游换模');
        expect(q('reply-reroute')?.getAttribute('data-tone')).toBe('warning');
        expect(q('reply-record')).toBeNull();
        click('reply-record-toggle');
        expect(q('reply-record')?.querySelector('[data-served-reroute="true"]')).not.toBeNull();
      });

      it('same model (any case), or no observation, says nothing', () => {
        render(withMeta({ servedModel: 'GPT-5.6-Sol' }));
        expect(q('reply-reroute')).toBeNull();
        render(withMeta({}));
        expect(q('reply-reroute')).toBeNull();
      });

      it('an unknown requested model has nothing to compare against: no warning', () => {
        render(withMeta({ model: '', servedModel: 'gpt-6-sol' }));
        expect(q('reply-reroute')).toBeNull();
      });
    });

    describe('a merged reply and a plain one', () => {
      it('a reply that merged a spoken callback keeps the spoken part as the body and the stream text in the record', () => {
        render(
          streamReply({
            origin: 'callback',
            content: '流式里的过程\n\n对你说的话',
            extra: {
              stream: {
                invocationId: 'parent-1',
                turnInvocationId: 'turn-1',
                cliStdout: '流式里的过程',
                speechContent: '对你说的话',
              },
            },
          }),
        );

        expect(q('message-bubble')?.textContent).toContain('对你说的话');
        expect(q('message-bubble')?.textContent).not.toContain('流式里的过程');
        click('reply-record-toggle');
        const stdout = q('reply-record-working-text');
        expect(stdout?.textContent).toBe('流式里的过程');
        expect(stdout?.getAttribute('data-context-quote-segment-id')).toBe('stdout');
        expect(stdout?.getAttribute('data-context-quote-projection-version')).not.toBeNull();
      });

      it('marks every unresolved parallel call as running, and never marks a terminal orphan as completed', () => {
        render(streamReply({ isStreaming: true, toolEvents: [tool('t1', 'Read'), tool('t2', 'Bash')] }));
        click('reply-record-toggle');
        expect(q('reply-record-tool-t1')?.getAttribute('data-state')).toBe('running');
        expect(q('reply-record-tool-t2')?.getAttribute('data-state')).toBe('running');

        harness.run(resetMessageDisclosureStateForTest);
        render(streamReply({ isStreaming: false, toolEvents: [tool('t3', 'Read')] }));
        click('reply-record-toggle');
        expect(q('reply-record-tool-t3')?.getAttribute('data-state')).toBe('unconfirmed');
      });

      it('a plain callback reply with nothing to record has no last line at all', () => {
        render({
          id: 'plain-1',
          type: 'assistant',
          catId: 'opus',
          origin: 'callback',
          content: '收到。',
          timestamp: 1,
          extra: { isExplicitPost: true },
        });

        expect(q('message-bubble')?.textContent).toContain('收到。');
        expect(q('reply-last-line')).toBeNull();
      });

      it('thinking goes into the record, not above the reply', () => {
        render(streamReply({ thinking: '先核对一下上一版的参数' }));

        expect(harness.container.textContent).not.toContain('先核对一下上一版的参数');
        click('reply-record-toggle');
        expect(q('reply-record-thinking')?.textContent).toContain('先核对一下上一版的参数');
      });
    });
  });
});
