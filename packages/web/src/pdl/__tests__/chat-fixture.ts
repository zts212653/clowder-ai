import { createCatId } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import type { ChatData } from '../chat-models';
import type { ChatUiState, SidebarSnapshot } from '../types';
import type { SidebarSource } from '../useSidebarBindings';
import { ownerData, ownerInput } from './owner-fixtures';

// Tests edit a synthetic fixture as a draft. Publish immutable receipts, just as
// the React stores do, keeping references for records that the edit did not touch.
const fixtureReceipts = new WeakMap<object, Record<string, unknown>>();
function fixtureReceipt<T>(value: T, previous?: unknown): T {
  if (value === previous || value == null || typeof value !== 'object') return value;
  const tag = Object.prototype.toString.call(value);
  if (tag !== '[object Object]' && tag !== '[object Array]') return value;
  const before = previous as Record<string, unknown> | undefined;
  const entries = Object.entries(value)
    .filter(([, item]) => typeof item !== 'function' && item !== undefined)
    .map(([key, item]) => [key, fixtureReceipt(item, before?.[key])] as const);
  if (before && entries.length === Object.keys(before).length && entries.every(([key, item]) => before[key] === item))
    return previous as T;
  return (Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries)) as T;
}

export function fixtureInput(data: ChatData) {
  /* eslint-disable @typescript-eslint/no-unused-vars -- host-only fields are excluded from pushed chat data */
  const {
    threads: _threads,
    projectPins: _pins,
    projectNames: _names,
    fileUrl: _fileUrl,
    input: _input,
    ...chat
  } = data;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  const records = (values: Record<string, object> | undefined) =>
    Object.fromEntries(
      Object.entries(values ?? {}).map(([id, row]) => [
        id,
        Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value !== 'function')),
      ]),
    );
  const next = {
    project: ownerData(),
    outputPreference: { mode: 'whole', status: 'ready', error: null },
    chat: {
      ...chat,
      questions: records(data.questions),
      proposals: records(data.proposals),
      schedules: records(data.schedules),
      memoryProposals: records(data.memoryProposals),
    },
  };
  const previous = fixtureReceipts.get(data) ?? {};
  const value = fixtureReceipt(next, previous.input);
  fixtureReceipts.set(data, { ...previous, input: value });
  return value;
}

export function fixtureSidebar(data: ChatData, source: Partial<SidebarSource> = {}): SidebarSnapshot {
  const next = {
    owner: null,
    classification: { phase: 'idle', error: '', newLabels: [], suggestions: [] },
    attention: [],
    ...source,
    threads: data.threads,
    threadId: data.threadId,
    executions: data.executions,
    projectPins: [...(data.projectPins ?? [])],
    projectNames: [...(data.projectNames ?? [])],
    timeZone: data.me.timeZone,
    load: '',
  };
  const previous = fixtureReceipts.get(data) ?? {};
  const value = fixtureReceipt(next, previous.sidebar);
  fixtureReceipts.set(data, { ...previous, sidebar: value });
  return value;
}

export function fixtureUi(): ChatUiState & ReturnType<typeof ownerInput> {
  return {
    ...ownerInput(),
    draft: { 'chat-input': '' },
    target: '',
    navHidden: false,
    viewCat: null,
    reply: null,
    pop: null,
    find: { q: '', scope: 'thread', sort: 'time', active: false },
    group: 'recent',
    tag: null,
    speaking: null,
    multi: false,
    picked: {},
    execOpen: {},
    whisper: false,
    whisperTo: [],
    renaming: false,
    queueOpen: false,
    clock: Date.now(),
    f: {},
  };
}

/** Public synthetic fixture; no local conversation data or live API is used. */
export function fixtureData(): ChatData {
  return {
    threadId: 'pdl-test',
    threads: [
      {
        id: 'pdl-test',
        title: '对话绑定验收',
        projectPath: '/project',
        createdBy: 'test-owner',
        participants: ['codex'],
        preferredCats: ['codex'],
        createdAt: 1793664000000,
        lastActiveAt: 1793664000000,
      },
    ],
    messages: [
      { id: 'user-1', type: 'user', content: '检查消息、引用与公式。', timestamp: 1793664000000 },
      {
        id: 'reply-1',
        type: 'assistant',
        catId: 'codex',
        content: '**消息已接入**\n\n$$\nx^2+y^2=z^2\n$$',
        timestamp: 1793664001000,
        replyTo: 'user-1',
        replyPreview: { content: '检查消息、引用与公式。', senderCatId: null },
      },
    ],
    routingPreview: { status: 'ready', targetCats: [createCatId('codex')], reason: { kind: 'default_cat' } },
    cats: [
      {
        id: 'codex',
        displayName: 'Codex',
        mentionPatterns: ['@codex'],
        color: { primary: '#527b99', secondary: '#e8eff5' },
        avatar: '',
        defaultModel: 'GPT',
        isDefaultResponder: true,
      } as CatData,
    ],
    me: { name: '验收用户', mentionPatterns: ['@test'], timeZone: 'UTC' },
    input: '',
    drafts: {},
    images: [],
    contexts: [],
    reply: null,
    loading: false,
    hasMore: false,
    connected: true,
    uploadStatus: 'idle',
    uploadError: null,
    queue: [],
    executions: [],
    activeRuns: [],
    preparingImages: false,
    unrestoredImages: 0,
    questions: {},
    historyEntries: [],
  };
}
