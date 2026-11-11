import { createCatId, type ProviderSubexecutionSemanticEvent } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { chatModels, composerTrigger } from '../chat-models';
import { fixtureData, fixtureUi } from './chat-fixture';

describe('chat contract projections', () => {
  it('derives execution rows once per unchanged message and keeps paired output when another source changes', () => {
    const data = fixtureData(),
      ui = fixtureUi();
    data.messages[1] = {
      ...data.messages[1],
      toolEvents: [
        {
          id: 'call',
          type: 'tool_use',
          executionRef: 'execution',
          toolUseId: 'tool',
          toolName: 'Read',
          label: 'Read file',
          timestamp: 1,
        },
        {
          id: 'result',
          type: 'tool_result',
          executionRef: 'execution',
          toolUseId: 'tool',
          label: 'Read file',
          detail: 'Read result',
          timestamp: 2,
        },
      ],
    };
    const before = chatModels(data, ui).chatStream.items[1].exec;
    const changed = {
      ...data,
      connected: false,
      messages: [{ ...data.messages[0], content: 'Changed input' }, data.messages[1]],
    };
    expect(chatModels(changed, ui).chatStream.items[1].exec).toBe(before);
    changed.messages[1] = {
      ...data.messages[1],
      toolEvents: data.messages[1].toolEvents!.map((event) =>
        event.type === 'tool_result' ? { ...event, detail: 'Changed result' } : event,
      ),
    };
    const after = chatModels(changed, ui).chatStream.items[1].exec;
    expect(after).not.toBe(before);
    expect(after!.groups[2].items).toMatchObject([
      {
        title: 'Read',
        details: [
          { part: 'call', text: 'Read file' },
          { part: 'result', tool: { part: 'result', result: 'Changed result', call: { toolName: 'Read' } } },
        ],
      },
    ]);
  });
  it('reads identity views without visiting the message or thread collections', () => {
    const data = fixtureData();
    Object.defineProperty(data, 'messages', {
      get() {
        throw new Error('Message owner was read');
      },
    });
    Object.defineProperty(data, 'threads', {
      get() {
        throw new Error('Thread owner was read');
      },
    });
    expect(chatModels(data, fixtureUi()).memberCatalog[0].id).toBe('codex');
    expect(chatModels(data, fixtureUi()).memberSettings.cats[0].id).toBe('codex');
    expect(chatModels(data, fixtureUi()).me.name).toBe('验收用户');
  });
  it('projects the project name as its chip and the full path as its copy control', () => {
    const data = fixtureData(),
      ui = fixtureUi();
    const path = '/projects/absolute/clowder-ai';
    data.threads[0] = { ...data.threads[0], projectPath: path };
    data.projectNames = new Map([[path, 'clowder-ai']]);
    data.me = { ...data.me, color: data.cats[0].color };
    ui.pop = { kind: 'projView' };
    const vm = chatModels(data, ui);
    expect(vm.chatComposer.proj).toMatchObject({ name: 'clowder-ai', path, home: false });
    expect('pathCopy' in vm.chatPop && vm.chatPop.pathCopy).toBe(path);
    expect(vm.chatPop.kind).toBe('projView');
    expect(vm.me.color).toBe(data.me.color);
  });
  it('uses backend member order and detects caret-local mentions and hash context without matching email or mid-word hash', () => {
    const data = fixtureData(),
      ui = fixtureUi();
    data.cats.unshift({ ...data.cats[0], id: 'first', displayName: 'First owner member', mentionPatterns: ['@first'] });
    ui.pop = composerTrigger('@', 1);
    const popup = chatModels(data, ui).chatPop;
    expect('mentions' in popup && popup.mentions.slice(0, 2)).toMatchObject([
      { id: 'first', ins: '@first', index: 0 },
      { id: 'codex', ins: '@codex', index: 1 },
    ]);
    expect(composerTrigger('before #doc tail', 11)).toMatchObject({ kind: 'ctx', q: 'doc', start: 7, end: 11 });
    expect(composerTrigger('a@b', 3)).toBeNull();
    expect(composerTrigger('a#b', 3)).toBeNull();
  });
  it('pairs tools only within the same execution, uses existing details and groups thinking, actual subagents and tools', () => {
    const data = fixtureData(),
      message = data.messages[1];
    message.isStreaming = true;
    message.thinking = 'Actual thinking';
    const child: ProviderSubexecutionSemanticEvent = {
      v: 1,
      kind: 'subexecution',
      id: 'child-start',
      stage: 'started',
      occurredAt: 1,
      subexecutionId: 'actual-child',
      rootExecutionId: 'root',
      parentExecutionId: 'root',
      rootTurnId: 'turn',
      parentTurnId: 'turn',
      agentPath: '/root/review-owner',
      depth: 1,
      nickname: 'Actual child',
      provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'subAgentActivity' },
    };
    message.metadata = {
      provider: 'codex',
      model: 'owner-model',
      subexecutionEvents: [child, { ...child, id: 'child-message', stage: 'message', content: 'Owner child output' }],
    };
    message.toolEvents = [
      {
        id: 'use-a',
        type: 'tool_use',
        toolUseId: 'same',
        executionRef: 'turn-a',
        toolName: 'read_file',
        label: 'Read source',
        detail: '{"path":"src/a.ts"}',
        timestamp: 1,
      },
      {
        id: 'use-b',
        type: 'tool_use',
        toolUseId: 'same',
        executionRef: 'turn-b',
        toolName: 'run_tests',
        label: 'Test source',
        detail: '{"suite":"owner"}',
        timestamp: 2,
      },
      {
        id: 'result-a',
        type: 'tool_result',
        toolUseId: 'same',
        executionRef: 'turn-a',
        label: 'Result',
        detail: 'short',
        inputDetail: '{"path":"src/a.ts"}',
        resultMeta: 'Actual recall metadata',
        status: 'error',
        timestamp: 3,
      },
      {
        id: 'result-b',
        type: 'tool_result',
        toolUseId: 'same',
        executionRef: 'turn-b',
        label: 'Result',
        detail: 'Passed',
        status: 'ok',
        timestamp: 4,
      },
    ];
    const exec = chatModels(data, fixtureUi()).chatStream.items[1].exec!;
    expect(exec.live).toBe(true);
    expect(exec.groups.map((group) => group.key)).toEqual(['thinking', 'subagents', 'tools']);
    expect(exec.groups[0].items[0]).toMatchObject({ kind: 'thinking', detail: 'Actual thinking' });
    expect(exec.groups[1].items).toMatchObject([
      { title: 'Actual child', kind: 'subagent', detail: 'Owner child output' },
    ]);
    expect(exec.groups[2].items).toMatchObject([
      {
        key: 'use-a',
        title: 'read_file',
        kind: 'tool',
        status: 'error',
        details: [
          { part: 'call', text: 'Read source' },
          { part: 'input', text: '{"path":"src/a.ts"}' },
          { part: 'result', tool: { result: 'short' } },
          { part: 'meta', text: 'Actual recall metadata' },
        ],
      },
      {
        key: 'use-b',
        title: 'run_tests',
        kind: 'tool',
        status: 'ok',
        details: [
          { part: 'call', text: 'Test source' },
          { part: 'input', text: '{"suite":"owner"}' },
          { part: 'result', tool: { result: 'Passed' } },
        ],
      },
    ]);
    message.isStreaming = false;
    expect(chatModels(data, fixtureUi()).chatStream.items[1].exec!.live).toBe(false);
  });
  it('shows canonical routing recipients instead of inferring a preferred member or displaying automatic twice', () => {
    const data = fixtureData(),
      ui = fixtureUi();
    data.cats.push({ ...data.cats[0], id: 'owner-target', displayName: '实际成员', mentionPatterns: ['@owner'] });
    data.routingPreview = {
      status: 'ready',
      targetCats: [createCatId('owner-target')],
      reason: { kind: 'default_cat' },
    };
    expect(chatModels(data, ui).chatComposer.target).toMatchObject({
      who: 'owner-target',
      name: '实际成员',
      handle: '@owner',
      auto: true,
    });
    ui.target = 'codex';
    expect(chatModels(data, ui).chatComposer.target).toMatchObject({ who: 'codex', name: 'Codex', auto: false });
    ui.whisper = true;
    ui.whisperTo = ['owner-target'];
    expect(chatModels(data, ui).chatComposer.target).toMatchObject({
      who: 'owner-target',
      name: '实际成员',
      auto: false,
    });
    ui.whisper = false;
    ui.target = '';
    data.routingPreview = { status: 'loading', targetCats: [], reason: null };
    expect(chatModels(data, ui).chatComposer.target).toMatchObject({
      who: null,
      name: '',
      auto: true,
      route: { reason: 'auto', names: [] },
    });
  });
  it('keeps multiple actual routing recipients and emits no normal-state notices', () => {
    const data = fixtureData();
    data.routingPreview = {
      status: 'ready',
      targetCats: [createCatId('codex'), createCatId('unlisted-owner')],
      reason: { kind: 'default_cat' },
    };
    const vm = chatModels(data, fixtureUi());
    expect(vm.chatComposer.target).toMatchObject({
      who: null,
      name: '',
      auto: true,
      route: { reason: 'auto', names: ['Codex', 'unlisted-owner'] },
    });
    expect(vm.chatComposer.notices).toEqual([]);
    data.connected = false;
    expect(chatModels(data, fixtureUi()).cafeHome.state).toBe('disconnected');
  });
  it('keeps Queue previews out of History and retains the real queue entry/target identity', () => {
    const data = fixtureData();
    data.messages.push({
      id: 'preview',
      queuedEntryId: 'queue-1',
      type: 'user',
      content: '等待处理',
      timestamp: 1793664002000,
    });
    data.queue.push({
      id: 'queue-1',
      threadId: data.threadId,
      content: '等待处理',
      targetCats: ['codex'],
      intent: 'execute',
      status: 'queued',
      createdAt: 1793664002000,
    } as QueueEntry);
    const vm = chatModels(data, fixtureUi());
    expect(vm.chatStream.items.map((m) => m.mid)).toEqual(['user-1', 'reply-1']);
    expect(vm.chatComposer.queue?.items[0]).toMatchObject({
      key: 'queue-1',
      index: 0,
      to: ['codex'],
      text: '等待处理',
      queued: true,
      orderable: true,
    });
  });

  it('uses exact message ids for streamed replacements and reply references', () => {
    const data = fixtureData();
    const before = chatModels(data, fixtureUi()).chatStream.items[1];
    data.messages[1] = { ...data.messages[1], content: '继续输出', isStreaming: true };
    const after = chatModels(data, fixtureUi()).chatStream.items[1];
    expect(after.mid).toBe(before.mid);
    expect(after.md).toBe('继续输出');
    expect(after.quote?.mid).toBe('user-1');
  });

  it("shows the active run's processing response as replying: tip before output, current action, then silence", () => {
    const data = fixtureData(),
      lifecycle = {
        kind: 'response',
        invocationId: 'inv-1',
        targetId: 'codex',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 1,
      } as never;
    data.messages[1] = { ...data.messages[1], content: '', timestamp: Date.now(), lifecycle };
    expect(chatModels(data, fixtureUi()).chatStream.items[1]).toMatchObject({ kind: 'cat', md: '正在回复…' });
    data.activeRuns = [{ responseMessageId: 'reply-1', invocationId: 'inv-1' } as never];
    const pending = chatModels(data, fixtureUi()).chatStream.items[1];
    expect(pending).toMatchObject({
      kind: 'typing',
      md: '',
      // Nothing yet but a capability tip: the reply is the author row plus the tip alone, no message card.
      tip: expect.any(String),
      meta: null,
    });
    data.messages[1] = {
      ...data.messages[1],
      toolEvents: [{ id: 'call', type: 'tool_use', toolName: 'Read', label: 'Read file', timestamp: 5 }],
    };
    expect(chatModels(data, fixtureUi()).chatStream.items[1].meta).toMatchObject({
      roll: { a: 'Read file', tools: 1, subs: 0, at: 5 },
    });
    data.live = { [data.threadId]: { codex: 'alive_but_silent' } };
    expect(chatModels(data, fixtureUi()).chatStream.items[1].meta).toMatchObject({ quiet: true, minutes: 0 });
  });

  it('keeps CLI stdout/thinking in the execution log instead of duplicating it into the body', () => {
    const data = fixtureData();
    data.messages[1] = {
      ...data.messages[1],
      origin: 'stream',
      content: '内部执行输出',
      thinking: '过程思考',
      extra: { stream: { speechContent: '最终回答', cliStdout: '内部执行输出' } },
    };
    const item = chatModels(data, fixtureUi()).chatStream.items[1];
    expect(item.md).toBe('最终回答');
    expect(JSON.stringify(item.exec)).toContain('内部执行输出');
    expect(JSON.stringify(item.exec)).toContain('过程思考');
  });

  it('keeps a stream-origin answer in the body when its output layout is unavailable', () => {
    const data = fixtureData(),
      content = 'Full answer. '.repeat(100);
    data.messages[1] = {
      ...data.messages[1],
      origin: 'stream',
      content,
      extra: {
        outputLayout: {
          v: 1,
          status: 'unavailable',
          reason: 'whole_body_replaced',
          owner: { threadId: data.threadId, catId: 'codex', turnInvocationId: 'turn' },
          contentRevision: { length: content.length, sha256: 'f'.repeat(64) },
        },
      },
    };
    const item = chatModels(data, fixtureUi()).chatStream.items[1];
    expect(item.md).toBe(content);
    expect(item.bodyLength).toBe(content.length);
    expect(item.relayed).toBe(false);
    expect(item.exec).toBeNull();
  });

  it('uses historical sender ids without substituting another configured member', () => {
    const data = fixtureData();
    data.messages[1].catId = 'retired-member';
    const vm = chatModels(data, fixtureUi());
    expect(vm.members.find((m) => m.id === 'retired-member')?.name).toBe('retired-member');
    expect(vm.chatStream.items[1].who).toBe('retired-member');
  });

  it('never projects recalled bodies or stale quote previews', () => {
    const data = fixtureData();
    data.messages[0].content = 'private recalled body';
    data.messages[0].extra = { recall: { version: 1, exposure: 'seen', recalledAt: 2 } };
    data.messages[1].replyPreview = { content: 'private recalled body', senderCatId: null };
    let vm = chatModels(data, fixtureUi());
    expect(JSON.stringify(vm)).not.toContain('private recalled body');
    expect(vm.chatStream.items[0]).toMatchObject({ md: '', recalled: true });
    data.messages[0].extra.recall!.exposure = 'none';
    vm = chatModels(data, fixtureUi());
    expect(vm.chatStream.items.map((m) => m.mid)).toEqual(['reply-1']);
    expect(JSON.stringify(vm)).not.toContain('private recalled body');
  });

  it('projects the existing deployment admission into the composer lock', () => {
    const data = fixtureData();
    data.input = 'ready to send';
    data.readonly = true;
    data.updateRequired = true;
    const vm = chatModels(data, fixtureUi());
    expect(vm.chatComposer.input.locked).toBe(true);
    expect(vm.chatComposer.send.disabled).toBe(true);
    expect(vm.chatPage.connection).toMatchObject({ updateRequired: true, canReload: true });
  });

  it('admits a context-only draft but blocks a whisper without recipients', () => {
    const data = fixtureData();
    data.contexts = [{ v: 1, id: 'ctx-1', kind: 'thread', threadId: 'other', title: '另一条对话' }];
    const ui = fixtureUi();
    expect(chatModels(data, ui).chatComposer.send.disabled).toBe(false);
    ui.whisper = true;
    expect(chatModels(data, ui).chatComposer.send.disabled).toBe(true);
    ui.whisperTo = ['codex'];
    expect(chatModels(data, ui).chatComposer.send.disabled).toBe(false);
  });
});

it('projects proven final text and ordered commentary/tools, and ignores it after recall or a body change', async () => {
  const { createHash } = await import('node:crypto');
  const { projectReplyOutput } = await import('@/components/reply-layers/reply-output');
  const data = fixtureData(),
    ui = fixtureUi(),
    content = 'before\n\nanswer',
    hash = createHash('sha256').update(content).digest('hex');
  const message = data.messages[1];
  message.content = content;
  message.origin = 'stream';
  message.catId = 'codex';
  message.toolEvents = [{ id: 'tool', executionRef: 'turn', type: 'tool_use', label: 'read source', timestamp: 1 }];
  message.extra = {
    stream: { invocationId: 'turn' },
    outputLayout: {
      v: 1,
      status: 'available',
      owner: { threadId: data.threadId, catId: 'codex', turnInvocationId: 'turn' },
      contentRevision: { length: content.length, sha256: hash },
      runs: [
        {
          id: 'process',
          identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'before' },
          channel: 'commentary',
          complete: true,
          start: 0,
          end: 6,
          gluePrefixLength: 0,
        },
        {
          id: 'final',
          identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'answer' },
          channel: 'final',
          complete: true,
          start: 6,
          end: content.length,
          gluePrefixLength: 2,
        },
      ],
      order: [
        { kind: 'run', runId: 'process' },
        { kind: 'tool', toolEventId: 'tool', executionRef: 'turn' },
        { kind: 'run', runId: 'final' },
      ],
    },
  };
  data.outputs = { [message.id]: { content, projection: projectReplyOutput(message, data.threadId, hash) } };
  let item = chatModels(data, ui).chatStream.items[1];
  expect(item.md).toBe('answer');
  expect(item.exec?.groups.find((group) => group.key === 'tools')?.items.map((row) => row.key)).toEqual([
    'process',
    'tool',
  ]);
  message.content = 'new unverified body';
  expect(chatModels(data, ui).chatStream.items[1].md).toBe('new unverified body');
  message.extra.recall = { version: 1, exposure: 'seen', recalledAt: 3 };
  item = chatModels(data, ui).chatStream.items[1];
  expect(item).toMatchObject({ md: '', recalled: true });
  expect(JSON.stringify(item)).not.toContain('answer');
});
