import {
  type ActiveExecutionProjection,
  type CapabilityTip,
  CORE_COMMANDS,
  type ContextAttachment,
  type LifecycleActiveRun,
  type MessageSearchResponse,
  projectThreadWorks,
  selectCapabilityTip,
  validateCapabilityTipInventory,
} from '@cat-cafe/shared';
import { hasAssistantBody, projectEmptyResponseLifecycleNotice } from '@/components/assistant-message-renderability';
import { initialState } from '@/components/hub-cat-editor.model';
import { pluginDeliveryReceipt } from '@/components/message-dispatch-projection';
import { projectMessagePartsForImage } from '@/components/message-export-parts';
import { selectMessagesForExport } from '@/components/message-export-selection';
import type { ReplyOutputProjection } from '@/components/reply-layers/reply-output';
import { projectReplySubexecutions, type ReplySubexecution } from '@/components/reply-layers/reply-subexecution';
import { scheduleEffect, scheduleTask } from '@/components/rich/read-schedule-approval';
import { adaptServiceState } from '@/components/settings/service-ui-adapter';
import { projectDisplayName } from '@/components/ThreadSidebar/thread-utils';
import { projectTargetReply } from '@/components/target-response-projection';
import { deduplicateRecallEvents, groupRecallEvents, recallReplyInvocationId } from '@/hooks/recall-feed-model';
import { filterRecallEvents } from '@/hooks/recall-tool-events';
import type { CatData } from '@/hooks/useCatData';
import type { RoutingPreviewState } from '@/hooks/useRoutingPreview';
import rawTips from '@/lib/capability-tips.seed.json';
import type { ChatMessage, QueueEntry, Thread, ToolEvent } from '@/stores/chat-types';
import { type CloudRecoveryBinding, cloudRecoveryView } from './cloud-models';
import { deliveryView, supplementView } from './delivery-models';
import { type MemoryMessageBinding, memoryMessageView } from './memory-message-proposals';
import { guessAndRenderCardType, type MessageCard } from './message-cards';
import { wholeSelected } from './message-selection';
import { type ProposalBinding, proposalView, type ScheduleBinding } from './proposal-models';
import { messageRichBlocks, richBlockView } from './rich-models';
import { type QuestionBinding, runtimeAskView } from './runtime-questions';
import type { ChatUiState } from './types';

export interface ChatData {
  threadId: string;
  newProjectId?: string;
  threads: Thread[];
  /** The thread list's first read is still running. */
  threadsLoading?: boolean;
  projectPins?: ReadonlySet<string>;
  projectNames?: ReadonlyMap<string, string>;
  messages: ChatMessage[];
  drafts: Record<string, boolean>;
  cats: CatData[];
  routingPreview: RoutingPreviewState;
  me: {
    name: string;
    mentionPatterns: string[];
    timeZone?: string;
    aliases?: string[];
    avatar?: string;
    color?: { primary: string; secondary: string };
  };
  input: string;
  images: File[];
  contexts: ContextAttachment[];
  reply: { id: string; content: string; senderCatId: string | null } | null;
  loading: boolean;
  hasMore: boolean;
  connected: boolean | null;
  forwardingBlocked?: boolean;
  readonly?: boolean;
  updateRequired?: boolean;
  uploadStatus: string;
  uploadError: string | null;
  queue: QueueEntry[];
  executions: ActiveExecutionProjection[];
  activeRuns?: readonly LifecycleActiveRun[];
  /** Addressed plugin instances: the @ candidates. */
  pluginTargets?: import('@/hooks/usePluginMentionTargets').PluginTargets;
  live?: Record<string, Record<string, string>>;
  preparingImages: boolean;
  search?: MessageSearchResponse;
  historyEntries: string[];
  questions: Record<string, QuestionBinding>;
  outputs?: Record<string, { content: string; projection?: ReplyOutputProjection }>;
  proposals?: Record<string, ProposalBinding>;
  schedules?: Record<string, ScheduleBinding>;
  cloudRecoveries?: Record<string, CloudRecoveryBinding>;
  memoryProposals?: Record<string, MemoryMessageBinding>;
  fileUrl?: (url: string) => string;
  contextSearch?: { query: string; files: { path: string }[]; worktreeId: string | null };
  voice?: { state: string; duration: number; text: string; available: boolean };
}

const tipInventory = validateCapabilityTipInventory(rawTips);
if (!tipInventory.success) throw new Error(`Invalid capability tips inventory:\n${tipInventory.errors.join('\n')}`);
const replyTips: readonly CapabilityTip[] = tipInventory.tips ?? [];
/* The replying line: one place, content by priority — silent (status says no activity) > current action > capability tip (no output yet, one per 30 s) */
function replySlot(
  message: ChatMessage,
  status: string | undefined,
  toolCount: number,
  subagents: number,
  bodyless: boolean,
  now: number,
) {
  const events = message.toolEvents ?? [];
  if (status === 'alive_but_silent' || status === 'suspected_stall')
    return {
      quiet: true,
      minutes: Math.floor((now - Math.max(message.timestamp, ...events.map((e) => e.timestamp))) / 60_000),
    };
  const act = events.findLast((e) => e.type === 'tool_use');
  if (act) return { roll: { a: act.label || act.toolName, tools: toolCount, subs: subagents, at: act.timestamp } };
  if (!bodyless) return {};
  const tip = selectCapabilityTip(replyTips, {
    contexts: ['thinking', 'long_running'],
    audience: 'cvo',
    rotationKey: Math.floor((now - message.timestamp) / 30_000),
  });
  return tip ? { tip: { tipId: tip.id, context: 'thinking', surface: 'pending_bubble' }, tipText: tip.body } : {};
}

const executionViews = new WeakMap<
  ChatMessage,
  {
    output: ReplyOutputProjection | undefined;
    stdout: string;
    threadId: string;
    events: ChatMessage['toolEvents'];
    thinking: string | undefined;
    subevents: ChatMessage['metadata'];
    streaming: boolean | undefined;
    value: ReturnType<typeof buildExecutionVM>;
  }
>();
function executionVM(
  message: ChatMessage,
  output: ReplyOutputProjection | undefined,
  stdout: string,
  threadId: string,
) {
  const old = executionViews.get(message);
  if (
    old &&
    old.output === output &&
    old.stdout === stdout &&
    old.threadId === threadId &&
    old.events === message.toolEvents &&
    old.thinking === message.thinking &&
    old.subevents === message.metadata &&
    old.streaming === message.isStreaming
  )
    return old.value;
  const value = buildExecutionVM(message, output, stdout, threadId);
  executionViews.set(message, {
    output,
    stdout,
    threadId,
    events: message.toolEvents,
    thinking: message.thinking,
    subevents: message.metadata,
    streaming: message.isStreaming,
    value,
  });
  return value;
}
function buildExecutionVM(
  message: ChatMessage,
  output: ReplyOutputProjection | undefined,
  stdout: string,
  dataThreadId: string,
) {
  const events = message.toolEvents ?? [],
    seen = new Set<string>();
  const pairKey = (event: ToolEvent) =>
    event.toolUseId && event.executionRef ? JSON.stringify([event.executionRef, event.toolUseId]) : event.id;
  const byId = new Map<string, ToolEvent>(),
    keys = new Map<ToolEvent, string>(),
    pairs = new Map<string, { call?: ToolEvent; result?: ToolEvent }>();
  for (const event of events) {
    if (!byId.has(event.id)) byId.set(event.id, event);
    const key = pairKey(event),
      pair = pairs.get(key) ?? {};
    keys.set(event, key);
    if (event.type === 'tool_use' && !pair.call) pair.call = event;
    if (event.type === 'tool_result' && !pair.result) pair.result = event;
    pairs.set(key, pair);
  }
  const order = output ? output.record : events.map((event) => ({ kind: 'tool' as const, id: event.id }));
  type Row = {
    key: string;
    title?: string;
    kind: 'tool' | 'commentary' | 'subagent' | 'thinking';
    status?: string;
    detail?: string;
    details?: {
      key: string;
      source: {
        kind: 'cli_output';
        threadId: string;
        messageId: string;
        toolUseId: string;
        executionRef: string;
        part: 'call' | 'input' | 'result' | 'meta';
      } | null;
      part: string;
      tool?: { call: ToolEvent | undefined; label: string; input: string | undefined; part: string; result: string };
      text?: string;
    }[];
  };
  const tools = order.flatMap<Row>((entry) => {
    if (entry.kind === 'text')
      return [
        {
          key: entry.id,
          title: entry.text,
          kind: 'commentary',
          detail: entry.text,
        },
      ];
    const event = byId.get(entry.id)!;
    const key = keys.get(event)!;
    if (seen.has(key)) return [];
    seen.add(key);
    const { call, result } = pairs.get(key)!;
    const name = call?.toolName;
    const input = result?.inputDetail ?? call?.inputDetail ?? call?.detail;
    const body = result?.detail;
    const parts = [
      { part: 'call' as const, text: call?.label ?? name },
      { part: 'input' as const, text: input },
      { part: 'result' as const, text: body },
      { part: 'meta' as const, text: result?.resultMeta },
    ];
    return [
      {
        key: call?.id ?? event.id,
        kind: 'tool',
        title: call ? call.toolName || call.label : event.label, // the tool's name; its label (who → tool) is in the details
        status: result?.status,
        details: parts
          .filter((p) => p.text !== undefined && p.text !== '')
          .map((p) => ({
            key: JSON.stringify([message.id, event.executionRef, event.toolUseId, p.part]),
            source:
              event.toolUseId && event.executionRef
                ? {
                    kind: 'cli_output' as const,
                    threadId: dataThreadId,
                    messageId: message.id,
                    toolUseId: event.toolUseId,
                    executionRef: event.executionRef,
                    part: p.part,
                  }
                : null,
            part: p.part,
            ...(p.part === 'result' && name
              ? { tool: { call, label: event.label, input, part: p.part, result: p.text! } }
              : { text: p.text! }),
          })),
      },
    ];
  });
  if (!output && stdout)
    tools.unshift({
      key: message.id + '-stdout',
      title: stdout,
      kind: 'commentary',
    });
  const subagents = (items: ReplySubexecution[]): Row[] =>
    items.flatMap((item) => [
      {
        key: item.key,
        title: item.nickname || item.taskId,
        kind: 'subagent',
        status: item.status,
        detail: item.messages.map((message) => message.content).join('\n\n'),
      },
      ...subagents(item.children),
    ]);
  const subs: Row[] = subagents(projectReplySubexecutions(message.metadata?.subexecutionEvents ?? []).roots);
  if (!tools.length && !message.thinking && !subs.length) return null;
  const thinking: Row[] = message.thinking
    ? [{ key: message.id + '-thinking', kind: 'thinking', title: message.thinking, detail: message.thinking }]
    : [];
  return {
    id: `exec-${message.id}`,
    live: !!message.isStreaming,
    groups: [
      {
        key: 'thinking',
        kind: 'thinking',
        items: thinking,
      },
      { key: 'subagents', kind: 'subagents', items: subs },
      { key: 'tools', kind: 'tools', items: tools },
    ],
  };
}

export function composerTrigger(text: string, caret: number): ChatUiState['pop'] {
  const mention = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (mention)
    return { kind: 'mention', typed: true, q: mention[2], start: caret - mention[2].length - 1, end: caret, i: 0 };
  const match = /(^|\s)#([^\s#]*)$/.exec(text.slice(0, caret));
  if (match) return { kind: 'ctx', typed: true, q: match[2], start: caret - match[2].length - 1, end: caret, i: 0 };
  return null;
}

export interface ChatProjectionInput {
  project?: {
    general?: ReturnType<typeof import('./useGeneralBindings').useGeneralBindings>['data'];
    sources?: ReturnType<typeof import('./useMessageSourceBindings').useMessageSourceBindings>['data'];
    reviews?: ReturnType<typeof import('./useReviewBindings').useReviewBindings>['data'];
    voice?: ReturnType<typeof import('./useVoiceBindings').useVoiceBindings>['data'];
    workbench?: ReturnType<typeof import('./useWorkbenchBindings').useWorkbenchBindings>['data'];
  };
  outputPreference?: { mode: string; status: string; error: unknown };
  admission?: { ready?: boolean; optionsLocked?: boolean };
  export?: {
    mids: readonly string[] | null;
    items?: readonly import('@cat-cafe/shared').ResolvedMessageSelectionItem[];
  };
}
export function evidenceMessageCards(source: NonNullable<ChatProjectionInput['project']>['sources']) {
  if (source?.error) return {};
  return Object.fromEntries(
    Object.entries(source?.records.evidence ?? {}).map(([mid, { blockId, view }]) => [
      mid,
      {
        blockId,
        title: view.response.query,
        foldStyle: 'middle',
        fields: view.response.results.flatMap((row) => [
          {
            k: row.threadTitle,
            v: `${row.speakerLabel ?? row.speaker}: ${row.snippet.text}`,
            act: 'msgJump',
            args: { t: row.threadId, mid: row.messageId },
          },
          ...(row.decisionSources ?? []).map((decision) => ({ k: decision.documentPath, v: decision.conclusion })),
        ]),
      },
    ]),
  );
}
function messageRecallCounts(data: ChatData, source: NonNullable<ChatProjectionInput['project']>['workbench']) {
  const live = data.messages.flatMap((message) =>
      message.extra?.crossPost || message.lifecycle?.kind === 'input'
        ? []
        : filterRecallEvents(message.toolEvents ?? []).map((event) => ({
            ...event,
            catId: message.catId,
            invocationId: recallReplyInvocationId(message),
            messageId: message.id,
            replyTimestamp: message.timestamp,
          })),
    ),
    events = deduplicateRecallEvents(
      live,
      source?.recall.events.map((event) => ({
        ...event,
        messageId: event.reply?.id ?? event.messageId,
        replyTimestamp: event.reply?.timestamp ?? event.replyTimestamp,
      })) ?? [],
    );
  return Object.fromEntries(
    groupRecallEvents(events, data.messages).flatMap((group) =>
      group.messageId ? [[group.messageId, group.events.length]] : [],
    ),
  );
}

function isPluginReplying(message: ChatMessage, timeline: readonly ChatMessage[]) {
  const reply = projectTargetReply(message, timeline);
  return !!reply?.showFrame && !reply.terminal;
}
function messageSender(message: ChatMessage) {
  return (
    message.from ??
    (message.type === 'user'
      ? { kind: 'user' as const, userId: 'me' }
      : message.catId
        ? { kind: 'agent' as const, catId: message.catId }
        : { kind: 'system' as const, service: 'clowder' })
  );
}

/** Console projection: its caller supplies the held raw snapshot, never a React model reader. */
/** A draft image's preview address: one object URL per picked File, reused across renders. */
const draftSources = new WeakMap<File, string>();
function draftSource(file: File): string {
  let url = draftSources.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    draftSources.set(file, url);
  }
  return url;
}

export function chatModels(data: ChatData, ui: ChatUiState, input?: ChatProjectionInput) {
  const raw = data,
    project = input?.project;
  const viewCat = () => {
    const bound = project?.general?.view;
    return bound?.threadId === data.threadId
      ? bound.value.effective.mode === 'cat'
        ? bound.value.effective.catId
        : null
      : ui.viewCat;
  };
  const related = {
    get evidenceCards() {
      return evidenceMessageCards(project?.sources);
    },
    get messageWorks() {
      return project?.sources?.records.works;
    },
    get generations() {
      return project?.sources?.records.generations;
    },
    get contextWorks() {
      return project?.reviews
        ? projectThreadWorks(project.reviews.global.artifacts, project.reviews.global.workLineage === 'resolved')
            .filter((work) => work.work)
            .map((work) => ({ workId: work.work!.contentRef, version: work.work!.ownerRevision, title: work.name }))
        : [];
    },
    get recallCounts() {
      return messageRecallCounts(raw, project?.workbench);
    },
  };
  const services = () => project?.voice?.services,
    available = (feature: string) => {
      const value = services();
      return value
        ? value.items.map(adaptServiceState).some((service) => service.features.includes(feature) && service.running)
        : false;
    };

  const messages = () =>
    data.messages
      .filter((m) => m.extra?.recall?.exposure !== 'none')
      .map((m) =>
        m.extra?.recall
          ? ({
              id: m.id,
              type: m.type,
              from: m.from,
              timestamp: m.timestamp,
              content: '',
              extra: { recall: m.extra.recall },
            } as ChatMessage)
          : m,
      );
  const safePreview = (mid: string | undefined, text: string) =>
    mid && data.messages.find((m) => m.id === mid)?.extra?.recall ? '' : text;
  const memberCatalog = () =>
    data.cats.map((cat) => ({
      id: cat.id,
      name: cat.nickname || cat.displayName,
      handle: cat.mentionPatterns[0] ?? '',
      avatarPath: cat.avatar,
      color: cat.color,
      model: cat.defaultModel,
      role: cat.roleDescription,
      breed: cat.breedDisplayName ?? '',
    }));
  const members = () => {
    const rows = [...memberCatalog()];
    for (const id of new Set(messages().flatMap((m) => (m.catId ? [m.catId] : []))))
      if (!rows.some((m) => m.id === id))
        rows.push({
          id,
          name: id,
          handle: '',
          avatarPath: '',
          color: { primary: '', secondary: '' },
          model: '',
          role: '',
          breed: '',
        });
    return rows;
  };
  const thread = () => data.threads.find((item) => item.id === data.threadId);
  const recipients = () =>
    ui.whisper
      ? ui.whisperTo
      : ui.target
        ? [ui.target]
        : data.routingPreview.status === 'ready'
          ? data.routingPreview.targetCats
          : [];
  const target = () => recipients()[0] || '';
  const recipientMembers = () =>
    recipients().map((id) => members().find((m) => m.id === id) ?? { name: id, handle: '' });
  const targetHandle = () => (recipientMembers().length === 1 ? recipientMembers()[0].handle : '');
  // A plugin's reply carrier is the reply's typing row until the reply arrives; a result without content shows nothing.
  const sourceMessages = (timeline = messages()) =>
    timeline
      .filter((m) => !m.queuedEntryId && m.extra?.systemKind !== 'context_briefing')
      .filter((m) => !(m.from?.kind === 'plugin' && m.extra?.targetResponseResult && !hasAssistantBody(m)))
      .filter((m) => !pluginDeliveryReceipt(m) || isPluginReplying(m, timeline))
      .filter((m) => !viewCat() || m.type === 'user' || m.catId === viewCat());
  /** Still replying: streaming, or the processing response the active run is writing (before its first output). */
  const replying = (message: ChatMessage) => {
    const lifecycle = message.lifecycle;
    return (
      !!message.isStreaming ||
      (lifecycle?.kind === 'response' &&
        lifecycle.status === 'processing' &&
        !!data.activeRuns?.some(
          (run) => run.responseMessageId === message.id && run.invocationId === lifecycle.invocationId,
        ))
    );
  };
  const text = (message: ChatMessage) => {
    const verified = data.outputs?.[message.id],
      output = message.extra?.outputLayout && verified?.content === message.content ? verified.projection : undefined,
      stream =
        message.origin === 'stream' &&
        !(message.lifecycle?.kind === 'response' && message.lifecycle.status === 'failed'),
      body = output
        ? output.answers.map((run) => run.text).join('\n\n')
        : stream
          ? (message.extra?.stream?.speechContent ??
            (message.extra?.stream?.cliStdout === '' && message.content
              ? message.content
              : message.extra?.stream?.cliStdout) ??
            message.content)
          : message.content,
      stdout = stream && message.extra?.stream?.cliStdout !== body ? (message.extra?.stream?.cliStdout ?? '') : '';
    const md = output
      ? body
      : body ||
        (message.contentBlocks ?? [])
          .flatMap((b) =>
            b.type === 'text'
              ? [b.text]
              : b.type === 'code'
                ? ['```' + (b.language ?? '') + '\n' + b.code + '\n```']
                : [],
          )
          .join('\n\n') ||
        (replying(message) ? '' : projectEmptyResponseLifecycleNotice(message)?.label) ||
        '';
    return { output, body, stdout, md };
  };
  // Records that belong to a message, by its id: each message reads only its own
  const byMessage = <T>(records: Record<string, T> | undefined, mid: (record: T) => string | undefined) => {
    const out = new Map<string, string[]>();
    Object.entries(records ?? {}).forEach(([key, record]) => {
      const id = mid(record);
      if (id) out.set(id, [...(out.get(id) ?? []), key]);
    });
    return out;
  };
  // The stream's rows and how one row becomes an item: a list can build (and keep) each item on its own
  const streamParts = () => {
    const evidenceCards = related.evidenceCards,
      recallCounts = related.recallCounts,
      timeline = messages(),
      rows = sourceMessages(timeline),
      proposalsOf = byMessage(data.proposals, (p) => p.target.mid),
      schedulesOf = byMessage(data.schedules, (s) => s.mid),
      memoryOf = byMessage(data.memoryProposals, (binding) => binding.target.mid);
    const item = (message: (typeof rows)[number], i: number) => {
      const from = messageSender(message),
        { output, body, stdout, md } = text(message);
      const frame = pluginDeliveryReceipt(message) ? projectTargetReply(message, timeline) : undefined;
      const execution = executionVM(message, output, stdout, data.threadId);
      const toolCount = execution?.groups[2].items.filter((row) => row.kind === 'tool').length ?? 0;
      const slot = replying(message)
        ? replySlot(
            message,
            data.live?.[data.threadId]?.[message.catId ?? ''],
            toolCount,
            execution?.groups[1].items.length ?? 0,
            !body,
            ui.clock,
          )
        : null;
      // A reply is the author row plus either the tip or the message card: with nothing yet but a tip, only the tip.
      const tipOnly = !!slot?.tip && !body && !execution?.groups.some((group) => group.items.length);
      const cards = guessAndRenderCardType(message, data.threadId),
        ask = cards.find((c): c is Extract<MessageCard, { type: 'ask' }> => c.type === 'ask'),
        work = cards.find(
          (c): c is Extract<MessageCard, { type: 'work' }> =>
            c.type === 'work' && !!related.messageWorks?.[message.id + ':' + c.blockId],
        );
      const record = ask ? data.questions[ask.interactionId] : undefined;
      const bound =
        record?.record?.cardRef?.messageId === message.id &&
        record.record.cardRef.blockId === ask?.blockId &&
        record.record.cardRef.threadId === data.threadId;
      const interactive = bound && record?.current && record.record?.request.kind ? record.record : undefined;
      const proposal = (proposalsOf.get(message.id) ?? []).map((key) => data.proposals![key]).find((p) => p.record);
      const schedule = (schedulesOf.get(message.id) ?? []).map((key) => data.schedules![key]).find((s) => s.proposal);
      const scheduleRecord = schedule?.proposal;
      const scheduleSettled = scheduleRecord?.status === 'approved' || scheduleRecord?.status === 'rejected';
      const cloud = data.cloudRecoveries?.[message.id];
      const memory = (memoryOf.get(message.id) ?? []).map((key) => data.memoryProposals![key])[0];
      return {
        kind: evidenceCards?.[message.id]
          ? 'evidence'
          : work
            ? 'workref'
            : cloud
              ? 'cloudRecovery'
              : memory
                ? memory.target.feature === 'F276'
                  ? 'memprop'
                  : 'proposal'
                : scheduleRecord
                  ? 'proposal'
                  : proposal
                    ? 'proposal'
                    : ask
                      ? 'ask'
                      : message.summary
                        ? 'summary'
                        : message.type === 'user'
                          ? 'user'
                          : frame
                            ? 'typing'
                            : message.type === 'system'
                              ? 'sys'
                              : replying(message) && !body
                                ? 'typing'
                                : 'cat',
        picking: ui.multi,
        picked: ui.picked[message.id] ? (wholeSelected(message, ui.picked[message.id]) ? true : 'mixed') : false,
        key: message.id,
        mid: message.id,
        i,
        who: frame ? frame.targetId : message.catId,
        from: frame ? ({ kind: 'plugin', instanceId: frame.targetId } as typeof from) : from,
        source: message.source,
        time: message.timestamp,
        chips: (message.contentBlocks ?? []).flatMap((b) =>
          b.type === 'context_attachment' && b.attachment.kind === 'work' ? [b.attachment] : [],
        ),
        md: frame ? '' : md,
        bodyLength: frame ? 0 : md.length,
        relayed: !!message.extra?.crossPost,
        recalled: !!message.extra?.recall,
        card:
          evidenceCards?.[message.id] ??
          (() => {
            const artifact = work && related.messageWorks?.[message.id + ':' + work.blockId];
            const ref = artifact?.work;
            return ref
              ? {
                  title: artifact.name,
                  wi: { contentRef: ref.contentRef, threadId: data.threadId },
                  rev: ref.ownerRevision,
                  latest: ref.currentOwnerRevision > ref.ownerRevision ? { rev: ref.currentOwnerRevision } : null,
                }
              : null;
          })() ??
          (cloud
            ? cloudRecoveryView(cloud)
            : memory
              ? memoryMessageView(memory, ui.f)
              : scheduleRecord
                ? {
                    title: scheduleTask(scheduleRecord).display.label,
                    schedule: scheduleRecord,
                    task: scheduleTask(scheduleRecord),
                    load: schedule!.current || scheduleSettled ? '' : 'loading',
                    canApproveSchedule: !scheduleSettled && !schedule!.blocked && !schedule!.drifted,
                    changes: (() => {
                      const mutation = scheduleRecord.mutation;
                      if (mutation.kind !== 'update') return [];
                      const template = schedule!.templates?.find(
                        (entry) => entry.templateId === mutation.taskSnapshot.templateId,
                      );
                      return Object.keys({ ...mutation.taskSnapshot.params, ...mutation.params })
                        .filter(
                          (key) =>
                            JSON.stringify(mutation.taskSnapshot.params[key]) !== JSON.stringify(mutation.params[key]),
                        )
                        .map((key) => ({
                          key,
                          description: template?.paramSchema[key]?.description,
                          before: mutation.taskSnapshot.params[key],
                          after: mutation.params[key],
                        }));
                    })(),
                    effect: scheduleEffect(scheduleRecord) !== null,
                    scheduleError: schedule!.error || schedule!.templateError,
                    canEditInPlace: false,
                    canRequestChange: false,
                    decided: scheduleSettled,
                    result: scheduleSettled
                      ? {
                          key: scheduleRecord.proposalId,
                          status: scheduleRecord.status,
                          reason: scheduleRecord.status,
                        }
                      : null,
                  }
                : proposal
                  ? proposalView(proposal, !!ui.editing?.[message.id], !!ui.asking?.[message.id], ui.f)
                  : ask
                    ? runtimeAskView(
                        bound
                          ? record
                          : record
                            ? { ...record, record: undefined, failed: record.failed || !!record.record }
                            : undefined,
                        message.id,
                        ui.f,
                        ui.runtime?.drafts[ask.interactionId]?.values,
                      )
                    : message.summary
                      ? {
                          title: message.summary.topic,
                          conclusions: message.summary.conclusions,
                          openQuestions: message.summary.openQuestions,
                        }
                      : null),
        quote:
          message.replyTo && message.replyPreview
            ? {
                mid: message.replyTo,
                text: safePreview(message.replyTo, message.replyPreview.content),
                from: message.replyPreview.senderCatId
                  ? { kind: 'agent', catId: message.replyPreview.senderCatId }
                  : { kind: 'user', userId: 'me' },
              }
            : null,
        rich: message.extra?.rich?.blocks ?? [],
        request: interactive?.request,
        terminal: interactive?.terminal,
        q: interactive
          ? [
              interactive.request.title,
              ...(interactive.request.kind === 'question' ? interactive.request.questions.map((q) => q.question) : []),
            ].join(' ')
          : body,
        error: message.variant === 'error',
        watcher: message.extra?.watcher,
        actsCtx: {
          mid: message.id,
          i,
          copy: message.content,
          fromMember: from.kind === 'agent',
          speaking: ui.speaking === message.id,
        },
        delivery: deliveryView(message, timeline, data.activeRuns ?? [], data.threadId).map((item) => {
          // The delivery moves with the member's run in this thread while delivered or being read; nothing once read
          // or when delivery failed. Its text is separate.
          const member = data.live?.[data.threadId]?.[item.who];
          return {
            ...item,
            live:
              (item.state === 'busy' || item.state === 'delivered') && !item.cloud && member !== 'done'
                ? (member ?? '')
                : '',
          };
        }),
        supp: supplementView(
          message,
          timeline,
          (id) => members().find((m) => m.id === id)?.name ?? id,
          data.me.name,
          related.generations?.[message.id],
        ),
        tip: tipOnly ? slot!.tipText : null,
        meta: frame
          ? { kind: 'typing' }
          : !tipOnly && (execution || replying(message) || recallCounts?.[message.id])
            ? {
                ...slot,
                open: ui.execOpen[message.id] ?? !!ui.recordExpanded,
                kind: replying(message) ? 'typing' : 'cat',
                toolCount,
                errors: execution?.groups[2].items.filter((row) => row.status === 'error').length ?? 0,
                subagents: execution?.groups[1].items.length ?? 0,
                processCount: output?.processCount ?? 0,
                model: message.metadata?.model,
                recall: recallCounts ? (recallCounts[message.id] ?? 0) : null,
              }
            : null,
        exec: execution,
        ownerCard: (() => {
          const c = cards.find((x) => x.type === 'frustration' || x.type === 'custody' || x.type === 'cbauth');
          return c ? { type: c.type, blockId: c.type === 'custody' ? '' : c.blockId } : null;
        })(),
        embeds: messageRichBlocks(message)
          .filter(
            (block) =>
              !cards.some((c) => (c.type === 'evidence' || c.type === 'work') && c.blockId === block.id) &&
              block.id !== proposal?.target.blockId &&
              block.id !== memory?.target.block.id &&
              block.id !== schedule?.blockId &&
              block.id !== ask?.blockId,
          )
          .flatMap((block) => {
            const rich = richBlockView(
              block,
              message.id,
              data.fileUrl ?? ((url) => url),
              ui.f,
              messageRichBlocks(message),
            );
            const registered = related.messageWorks?.[message.id + ':' + block.id]?.work;
            if (rich?.file && registered)
              rich.file.work = JSON.stringify({
                threadId: data.threadId,
                contentRef: registered.contentRef,
                ownerRevision: registered.ownerRevision,
              });
            if (rich && ui.multi && message.extra?.rich?.blocks.some((b) => b.id === block.id))
              Object.assign(rich, {
                sel: { on: !!ui.picked[message.id]?.blocks[block.id], mid: message.id, b: block.id },
              });
            return rich ? [{ key: `${message.id}:${block.id}`, blockId: block.id, rich }] : [];
          }),
        sel: ui.multi ? { on: !!ui.picked[message.id]?.text, mid: message.id } : null,
      };
    };
    // only ids and a builder leave the model: rows stay inside (a recalled body is never exposed)
    return { ids: rows.map((message) => message.id), item: (i: number) => item(rows[i], i) };
  };
  const items = () => {
    const parts = streamParts();
    return parts.ids.map((_, i) => parts.item(i));
  };
  const chosen = () => sourceMessages().filter((item) => ui.picked[item.id]);
  const notices = () => (data.uploadError ? [{ id: 'upload', text: data.uploadError }] : []);
  const locked = () =>
    !!data.readonly ||
    data.preparingImages ||
    data.uploadStatus === 'uploading' ||
    (data.threadId === 'default' && !!input?.admission && (!input.admission.ready || !!input.admission.optionsLocked));
  const reply = () =>
    data.reply
      ? {
          mid: data.reply.id,
          text: safePreview(data.reply.id, data.reply.content),
          from: data.reply.senderCatId
            ? { kind: 'agent', catId: data.reply.senderCatId }
            : { kind: 'user', userId: 'me' },
        }
      : null;
  const ctx = () =>
    data.contexts.map((attachment, index) => ({
      ...attachment,
      quote: attachment.kind === 'quote',
      index,
      label:
        attachment.kind === 'thread' ? attachment.title : attachment.kind === 'workspace_file' ? attachment.path : '',
    }));
  const attachments = () =>
    data.images.map((file, index) => ({
      index,
      name: file.name,
      kind: 'image',
      size: file.size,
      state: data.uploadStatus === 'uploading' ? 'up' : '',
      source: draftSource(file),
      preview: { kind: 'draftAttachment', i: index },
    }));
  const matches = () => {
    const recalled = new Set(data.messages.filter((m) => m.extra?.recall).map((m) => m.id));
    return sourceMessages()
      .filter(
        (m) =>
          !recalled.has(m.id) && ui.find.q && m.content.toLocaleLowerCase().includes(ui.find.q.toLocaleLowerCase()),
      )
      .sort((a, b) =>
        ui.find.sort === 'rel'
          ? b.content.toLowerCase().split(ui.find.q.toLowerCase()).length -
            a.content.toLowerCase().split(ui.find.q.toLowerCase()).length
          : b.timestamp - a.timestamp,
      );
  };
  const pop = () => ui.pop; // read where it is used: a model built for another view does not depend on it
  const mentionItems = () => {
    const catalog = memberCatalog().filter((member, i) => data.cats[i].roster?.available !== false && !!member.handle),
      breeds = new Map<string, number>();
    for (const member of catalog) if (member.breed) breeds.set(member.breed, (breeds.get(member.breed) ?? 0) + 1);
    return [
      ...catalog.map((member) => ({
        ...member,
        who: member.id,
        kind: 'member',
        meta: [member.breed, member.model],
        ins: member.handle,
        key: `${member.name}${member.handle}${member.breed}`.toLowerCase(),
      })),
      // a plugin instance is a candidate like a member; its avatar resolves from the instance id
      ...(data.pluginTargets?.targets ?? []).map((target) => ({
        who: target.id,
        kind: 'member',
        meta: [],
        name: target.displayName,
        handle: `@${target.alias}`,
        ins: `@${target.alias}`,
        key: `${target.displayName}@${target.alias}`.toLowerCase(),
      })),
      { kind: 'thread', ins: '@thread', key: 'thread' },
      { kind: 'all', ins: '@all', key: 'all' },
      ...[...breeds]
        .filter(([, count]) => count >= 2)
        .map(([breed, count]) => ({
          kind: 'breed',
          breed,
          count,
          key: breed.toLowerCase(),
        })),
    ]
      .filter((row) => row.key.includes((pop()?.q ?? '').toLowerCase()))
      .map((row, index) => ({ ...row, index, selected: index === pop()?.i }));
  };
  const contextItems = () => {
    const query = (pop()?.typed ? pop()!.q : data.contextSearch?.query) ?? '',
      matches = (value: string) => value.toLowerCase().includes(query.toLowerCase());
    const threads = data.threads
      .filter((t) => !t.deletedAt && t.id !== data.threadId && t.id !== 'default' && matches(`${t.title} ${t.id}`))
      .map((t) => ({ kind: 'THREAD', id: t.id, title: t.title, label: t.title, sub: t.id, thread: true }));
    const files = (data.contextSearch?.files ?? [])
      .filter((f) => matches(f.path))
      .map((f) => ({
        kind: 'FILE',
        path: f.path,
        title: f.path.split('/').at(-1),
        label: f.path.split('/').at(-1),
        sub: f.path,
      }));
    const works = related.contextWorks
      .filter((w) => matches(w.title))
      .map((w) => ({
        kind: 'work',
        title: w.title,
        label: w.title,
        version: w.version,
        attachment: { v: 1, kind: 'work', ...w },
      }));
    return {
      threads,
      files,
      works,
      items: [...threads, ...files, ...works].map((row, index, rows) => ({
        ...row,
        index,
        selected: index === pop()?.i,
        section: index === 0 || rows[index - 1].kind !== row.kind ? row.kind : '',
      })),
    };
  };
  const mediaPreview = () => {
    const draft = ui.lb?.target?.kind === 'draftAttachment' ? data.images[ui.lb.target.i] : undefined;
    if (draft)
      return {
        target: ui.lb!.target,
        title: draft.name,
        media: {
          id: `draft:${ui.lb!.target!.i}`,
          kind: 'image',
          src: draftSource(draft),
          label: draft.name,
          marks: [],
        },
      };
    const previewSource = ui.lb
      ? data.messages.find((message) => message.id === ui.lb!.mid && !message.extra?.recall)
      : undefined;
    const previewBlock = previewSource
      ? messageRichBlocks(previewSource).find((block) => block.id === ui.lb!.block)
      : undefined;
    const gallery = previewBlock?.kind === 'media_gallery' ? previewBlock : undefined;
    const previewIndex = gallery?.items.length
      ? ((ui.lb!.i % gallery.items.length) + gallery.items.length) % gallery.items.length
      : 0;
    const image = gallery?.items[previewIndex];
    const previewFile = image ? (data.fileUrl ? data.fileUrl(image.url) : image.url) : '';
    return image
      ? {
          id: `${previewSource!.id}:${previewBlock!.id}:${previewIndex}`,
          title: image.alt || gallery?.title,
          at: previewSource!.timestamp,
          author: previewSource!.catId
            ? members().find((member) => member.id === previewSource!.catId)!.name
            : data.me.name,
          index: previewIndex + 1,
          total: gallery!.items.length,
          many: gallery!.items.length > 1,
          source: previewFile,
          media: {
            id: `${previewSource!.id}:${previewBlock!.id}:${previewIndex}`,
            kind: 'image',
            src: previewFile,
            label: image.alt ?? '',
          },
        }
      : null;
  };
  const modal = ui.modal?.kind === 'forward' ? ui.modal : null;
  return {
    get chatModal() {
      return modal
        ? {
            data: {
              source: data.threadId,
              n: modal.messageIds?.length ?? 0,
              threads: data.threads
                .filter((t) => t.id !== data.threadId && !t.deletedAt)
                .map((t) => ({ id: t.id, title: t.title, selected: modal.to === t.id })),
            },
            submission: { disabled: !modal.to || !!modal.busy || data.forwardingBlocked !== false },
          }
        : null;
    },
    get members() {
      return members();
    },
    get memberCatalog() {
      return memberCatalog();
    },
    get memberSettings() {
      return { cats: data.cats.map((cat) => ({ ...cat, form: initialState(cat) })), owner: data.me };
    },
    get speechAvailable() {
      return available('voice-output');
    },
    get memberCard() {
      if (!ui.memberCard) return null;
      return (() => {
        const member = members().find((m) => m.id === ui.memberCard);
        return member
          ? {
              who: member.id,
              rows: [{ who: member.id, name: member.name, breed: member.breed, handle: member.handle }],
              model: member.model,
              role: member.role,
            }
          : null;
      })();
    },
    get mediaPreview() {
      return mediaPreview();
    },
    get threads() {
      return data.threads;
    },
    get me() {
      return {
        name: data.me.name,
        handle: data.me.mentionPatterns[0] ?? '',
        color: data.me.color,
        avatarPath: data.me.avatar ?? '',
      };
    },
    get chatStream() {
      return { items: items() };
    },
    get chatStreamParts() {
      return streamParts();
    },
    get threadExport() {
      const selected = input?.export
        ? selectMessagesForExport(raw.messages, input.export.mids ?? []).messages
        : raw.messages;
      return {
        items: input?.export
          ? chatModels(
              {
                ...raw,
                messages: input.export.items
                  ? selected.map((message) => projectMessagePartsForImage(message, input.export!.items!))
                  : selected,
              },
              { ...ui, viewCat: null },
              { ...input, export: undefined },
            ).chatStream.items
          : items(),
      };
    },
    get chatHeader() {
      return {
        navHidden: ui.navHidden,
        title: thread()?.title,
        id: data.threadId,
        pinned: !!thread()?.pinned,
        fav: !!thread()?.favorited,
        editing: ui.renaming,
        people: thread()?.participants ?? [],
        peopleCount: thread()?.participants.length ?? 0,
        viewCatName: viewCat() ? members().find((m) => m.id === viewCat())?.name : undefined,
        findOpen: pop()?.kind === 'find',
      };
    },
    get chatPage() {
      const pageItems = sourceMessages();
      return {
        connection: {
          updateRequired: !!data.updateRequired,
          canReload: !!data.updateRequired,
          isReadonly: !!data.readonly,
        },
        messages: pageItems.map((m) => ({ mid: m.id })),
        lobby: data.threadId === 'default',
        title: thread()?.title,
        older: data.loading ? 'loading' : !data.hasMore ? 'done' : '',
        viewCat: viewCat() ? members().find((m) => m.id === viewCat()) : null,
        find: ui.find.active ? { q: ui.find.q, index: pop()?.i ?? 0, count: matches().length } : null,
      };
    },
    get chatTicksParts() {
      const rows = sourceMessages();
      return {
        older: data.loading ? 'loading' : !data.hasMore ? 'done' : '',
        ids: rows.map((item) => item.id),
        item: (i: number) => {
          const item = rows[i];
          return {
            mid: item.id,
            from: messageSender(item),
            source: item.source,
            kind: item.type === 'user' ? 'user' : 'cat',
            time: item.timestamp,
            name: item.catId ? members().find((m) => m.id === item.catId)?.name : data.me.name,
            excerpt: text(item).md,
          };
        },
      };
    },
    get cafeHome() {
      return {
        navHidden: ui.navHidden,
        state: data.connected === false ? 'disconnected' : '',
      };
    },
    get chatWelcome() {
      return {};
    },
    get chatComposer() {
      const draftReply = reply();
      return {
        spot: false,
        home: data.threadId === 'default',
        multi: ui.multi,
        picked: chosen().length,
        locked: locked(),
        top: true,
        notices: notices(),
        runners: data.executions
          .filter((e) => e.threadId === data.threadId)
          .map((e) => {
            const member = members().find((m) => m.id === e.catId);
            return {
              who: e.catId,
              name: member?.name,
              handle: member?.handle,
              cur: target() === e.catId,
              command: e.kind === 'managed_command',
              kind: e.kind === 'live_invocation' ? 'reply' : 'command',
              what: e.activity,
              seconds: Math.floor((Date.now() - e.startedAt) / 1000),
              ticking: true,
              exec: e.executionId,
              mid: [...messages()].reverse().find((m) => m.catId === e.catId && replying(m))?.id,
            };
          }),
        queue: data.queue.length
          ? {
              key: data.threadId,
              items: data.queue.map((q, index) => ({
                key: q.id,
                index,
                text: q.content,
                to: q.targetCats,
                delivery: (() => {
                  const source = data.messages.find((message) => message.id === q.messageId);
                  const lifecycle = source?.lifecycle?.kind === 'input' ? source.lifecycle : null;
                  const refs = lifecycle?.dispatchRefs ?? [],
                    failures = lifecycle?.appendFailures ?? [];
                  return [
                    ...new Set([
                      ...q.targetCats,
                      ...refs.map((ref) => ref.targetId),
                      ...failures.map((failure) => failure.targetId),
                    ]),
                  ].map((id) => {
                    const ref = refs.find((entry) => entry.targetId === id),
                      response = ref && data.messages.find((message) => message.id === ref.statusMessageId);
                    const delivered =
                      response?.lifecycle?.kind === 'response' &&
                      response.lifecycle.targetId === id &&
                      response.lifecycle.inputMessageIds.includes(q.messageId!);
                    return {
                      id,
                      queued: q.targetCats.includes(id),
                      dispatch: delivered ? ref : null,
                      failure: failures.find(
                        (entry) => entry.targetId === id && (!ref || entry.responseMessageId === ref.statusMessageId),
                      ),
                    };
                  });
                })(),
                queued: q.status === 'queued',
                orderable: q.status === 'queued',
              })),
            }
          : null,
        input: {
          rec:
            data.voice && data.voice.state !== 'idle'
              ? {
                  secs: data.voice.duration,
                  busy: data.voice.state === 'transcribing',
                  text: data.voice.text,
                }
              : null,
          id: 'chat-input',
          home: data.threadId === 'default',
          whisper: ui.whisper,
          history: data.historyEntries,
          value: data.input,
          locked: locked(),
          draft: {
            any: !!(draftReply || ctx().length || attachments().length || ui.whisper),
            reply: draftReply,
            ctx: ctx(),
            att: attachments(),
            chips: ctx(),
            whisper: ui.whisper
              ? {
                  none: !ui.whisperTo.length,
                  to: ui.whisperTo.map((id) => ({
                    id,
                    name: members().find((m) => m.id === id)?.name ?? id,
                    handle: members().find((m) => m.id === id)?.handle,
                  })),
                }
              : null,
          },
        },
        proj: {
          home: data.threadId === 'default',
          name: (data.threadId === 'default' ? data.newProjectId : thread()?.projectPath)
            ? (data.projectNames?.get((data.threadId === 'default' ? data.newProjectId : thread()?.projectPath)!) ??
              projectDisplayName((data.threadId === 'default' ? data.newProjectId : thread()?.projectPath)!))
            : '',
          path: (data.threadId === 'default' ? data.newProjectId : thread()?.projectPath) ?? '',
        },
        target: {
          who: recipients().length === 1 ? target() : null,
          name: recipientMembers().length === 1 ? recipientMembers()[0].name : '',
          handle: targetHandle(),
          auto: !ui.target && !ui.whisper,
          route: {
            reason: ui.whisper ? 'whisper' : !ui.target ? 'auto' : 'recent',
            names: recipientMembers().map((m) => m.name),
            name: recipientMembers()[0]?.name,
            handle: targetHandle(),
          },
        },
        toolsCtx: { inputId: 'chat-input', rec: data.voice?.state === 'recording' },
        voiceAvailable: services() ? available('voice-input') : (data.voice?.available ?? false),
        send: {
          stop:
            !data.input.trim() &&
            !ctx().length &&
            !attachments().length &&
            data.executions.some((e) => e.threadId === data.threadId),
          stopping: false,
          disabled:
            locked() ||
            (ui.whisper && !ui.whisperTo.length) ||
            (!data.input.trim() &&
              !ctx().length &&
              !attachments().length &&
              !data.executions.some((e) => e.threadId === data.threadId)),
          reason: data.readonly
            ? 'readonly'
            : data.preparingImages || data.uploadStatus === 'uploading'
              ? 'uploading'
              : ui.whisper && !ui.whisperTo.length
                ? 'whisper'
                : 'send',
          home: data.threadId === 'default',
        },
      };
    },
    get chatPop() {
      const kind = pop()?.kind ?? '',
        subpage = pop()?.page ?? 'main';
      const base = {
        kind,
        pos: { up: !!pop()?.up, span: pop()?.span ?? 3, fit: !!pop()?.fit },
        typed: !!pop()?.typed,
        up: !!pop()?.up,
        subpage,
        page: `${kind}/${pop()?.page ?? ''}`,
        query: pop()?.q ?? '',
        mode: pop()?.mode ?? '',
        contextFilter: pop()?.q ?? '',
      };
      if (kind === 'slash') {
        const commands = CORE_COMMANDS.filter(
          (c) => c.surface !== 'connector' && c.name.slice(1).startsWith(pop()?.q ?? ''),
        );
        return {
          ...base,
          commands: commands.map((c, index) => ({
            section: index === 0 || commands[index - 1].category !== c.category ? c.category : '',
            command: c.name,
            index,
            selected: index === pop()?.i,
          })),
        };
      }
      if (kind === 'path')
        return {
          ...base,
          paths: (project?.workbench?.projectPicker.completions.entries ?? []).map((entry, index) => ({
            path: entry.path,
            index,
            selected: index === pop()?.i,
          })),
        };
      if (kind === 'ref') {
        const reference = data.contexts[pop()!.i!];
        return {
          ...base,
          source: reference.kind === 'quote' ? reference.source : reference.kind,
          selectionSource: reference.kind === 'quote' && reference.source.kind === 'message',
          quote: reference.kind === 'quote' ? reference.text : '',
          comment: reference.kind === 'quote' ? reference.comment : '',
          ref: { i: pop()!.i },
        };
      }
      if (kind === 'mention') return { ...base, mentions: mentionItems() };
      if (kind === 'ctx') {
        const contexts = contextItems();
        return {
          ...base,
          ctxSearch: pop()?.typed ? null : { q: data.contextSearch?.query ?? '' },
          contextQuery: pop()?.typed ? pop()!.q : (data.contextSearch?.query ?? ''),
          contexts: contexts.items,
          threads: contexts.threads.length,
          files: contexts.files.length,
          works: contexts.works.length,
        };
      }
      if (
        ['target', 'people', 'whisper'].includes(kind) ||
        (kind === 'plus' && ['whisper', 'prefer'].includes(subpage))
      )
        return {
          ...base,
          groupSelected: !viewCat(),
          members: members().map((member) => {
            const execution = data.executions.find((e) => e.catId === member.id && e.threadId === data.threadId);
            return {
              id: member.id,
              name: member.name,
              handle: member.handle,
              executing: !!execution,
              state: execution ? (execution.kind === 'live_invocation' ? 'reply' : 'command') : 'idle',
              selected:
                kind === 'people'
                  ? viewCat() === member.id
                  : kind === 'whisper' || subpage === 'whisper'
                    ? ui.whisperTo.includes(member.id)
                    : target() === member.id,
            };
          }),
        };
      if (kind === 'plus' && subpage === 'mode') return { ...base, sendScope: ui.sendScope, sendMode: ui.sendMode };
      if (kind === 'plus')
        return {
          ...base,
          sendMode: ui.sendMode,
          attachmentFull: data.images.length >= 5,
          whisperOn: ui.whisper,
          preferNames: recipientMembers().map((m) => m.name),
        };
      if (kind === 'projView')
        return { ...base, noProject: !thread()?.projectPath, pathCopy: thread()?.projectPath ?? '' };
      if (kind === 'projPick')
        return {
          ...base,
          noHomeProject: !data.newProjectId,
          projects: [
            ...new Set([...data.threads.map((t) => t.projectPath), ...(data.newProjectId ? [data.newProjectId] : [])]),
          ]
            .filter(Boolean)
            .map((path) => ({
              id: path,
              path,
              name: data.projectNames?.get(path) ?? projectDisplayName(path),
              selected: path === data.newProjectId,
            })),
        };
      if (kind === 'find') {
        const results =
          data.search?.query === ui.find.q.trim()
            ? data.search.results.map((r) => ({
                name: r.speakerLabel ?? r.speaker,
                time: r.timestamp,
                threadTitle: r.threadTitle,
                text: r.snippet.text,
              }))
            : matches().map((m) => ({
                name: m.catId ? members().find((c) => c.id === m.catId)?.name : data.me.name,
                time: m.timestamp,
                threadTitle: thread()?.title,
                text: m.content,
              }));
        return {
          ...base,
          find: { ...ui.find, done: !data.loading, count: results.length },
          results: results.map((r, index) => {
            const hitAt = r.text.toLowerCase().indexOf(ui.find.q.toLowerCase());
            return {
              index,
              name: r.name,
              time: r.time,
              threadTitle: r.threadTitle,
              allThreads: ui.find.scope === 'all',
              pre: r.text.slice(0, hitAt),
              hit: r.text.slice(hitAt, hitAt + ui.find.q.length),
              post: r.text.slice(hitAt + ui.find.q.length),
              hitAt,
            };
          }),
        };
      }
      return base;
    },
    get system() {
      const preference = input?.outputPreference;
      return {
        processTalk: {
          mode: preference?.mode,
          load: preference?.status === 'loading' ? 'loading' : preference?.error ? 'error' : '',
        },
      };
    },
  };
}
