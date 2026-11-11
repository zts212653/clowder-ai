import {
  parseRuntimeInteractionResponse,
  type RuntimeInteractionRecord,
  type RuntimeInteractionResponse,
  runtimeInteractionRequestSchema,
} from '@cat-cafe/shared';
import { submitConversationAnswer } from '@/components/rich/runtime-conversation-model';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';

export async function readRuntimeRecord(
  id: string,
  signal?: AbortSignal,
  fresh = false,
): Promise<RuntimeInteractionRecord> {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  const body = (await readApprovalProducerBody(
    { owner: owner ?? '', producer: 'F306', proposalId: id },
    `/api/runtime-interactions/${encodeURIComponent(id)}`,
    { signal, fresh },
  )) as { interaction?: RuntimeInteractionRecord };
  const record = body.interaction;
  const parsed = runtimeInteractionRequestSchema.safeParse(record?.request);
  if (
    !record ||
    !parsed.success ||
    parsed.data.interactionId !== id ||
    parsed.data.owner.userId !== owner ||
    !Number.isSafeInteger(record.revision)
  )
    throw new Error('请求状态不可用');
  return record;
}

export interface QuestionBinding {
  record?: RuntimeInteractionRecord;
  current: boolean;
  failed?: boolean;
  refresh: () => Promise<unknown>;
}

export interface QuestionRow {
  id: string;
  group: string;
  pickKey: string;
  skipKey: string;
  header: string;
  question: string;
  single: boolean;
  multi: boolean;
  opts: { v: string; label: string; sub: string; on: boolean }[];
  free: boolean;
  freeId: string;
  secret: boolean;
  canSkip: boolean;
  skipped: boolean;
}

export function questionRows(
  record: RuntimeInteractionRecord,
  mid: string,
  draft: Record<string, unknown>,
  prefix = 'ask',
): QuestionRow[] {
  const request = record.request;
  if (request.kind !== 'question') return [];
  const questions = request.questions;
  return questions.map((question) => {
    const group = `${prefix}-${encodeURIComponent(mid).replaceAll('.', '%2E')}-${encodeURIComponent(question.id).replaceAll('.', '%2E')}`;
    const skipped = !!draft[`skip-${group}`];
    const multi = (draft[`m-${group}`] ?? {}) as Record<string, boolean>;
    return {
      id: question.id,
      group,
      pickKey: group,
      skipKey: group,
      header: question.header,
      question: question.question,
      single: !skipped && !!question.options?.length && !question.multiSelect,
      multi: !skipped && !!question.options?.length && !!question.multiSelect,
      opts: (question.options ?? []).map((option) => ({
        v: option.label,
        label: option.label,
        sub: option.description || '',
        on: !!multi[option.label],
      })),
      free: !skipped && (!!question.isOther || !!question.isSecret || !question.options?.length),
      freeId: `${group}-t`,
      secret: !!question.isSecret,
      canSkip: !!question.allowUnanswered,
      skipped,
    };
  });
}

export async function submitRuntimeAnswers(
  id: string,
  card: { threadId: string; messageId: string; blockId: string },
  answers: Record<string, string[]>,
  attempt?: {
    expected: RuntimeInteractionRecord;
    operationId: string;
    customInput?: string;
    response?: RuntimeInteractionResponse;
  },
): Promise<void> {
  const expected = attempt?.expected;
  if (expected?.request.kind === 'conversation_decision' && attempt) {
    if (
      !expected.cardRef ||
      expected.cardRef.threadId !== card.threadId ||
      expected.cardRef.messageId !== card.messageId ||
      expected.cardRef.blockId !== card.blockId
    )
      throw new Error('请求已变化，请重新读取');
    const selectedIds = answers[expected.request.presentation.id] ?? [];
    const customInput = attempt.customInput;
    const response = parseRuntimeInteractionResponse(
      expected.request,
      attempt.response ?? {
        kind: 'selection',
        selectedIds,
        ...(customInput ? { customInput } : {}),
      },
    );
    if (response.kind !== 'selection' && response.kind !== 'text') throw new Error('回答类型不匹配');
    const next = await submitConversationAnswer(
      {
        interactionId: id,
        ownerUserId: expected.request.owner.userId,
        expectedRevision: expected.revision,
        cardRef: expected.cardRef,
        operationId: attempt.operationId,
      },
      response,
    );
    approvalResultRead.seedFacts(
      { owner: expected.request.owner.userId, producer: 'F306', proposalId: id },
      { native: { interaction: next } },
    );
    return;
  }
  const record = await readRuntimeRecord(id, undefined, true);
  if (
    record.status !== 'pending' ||
    (attempt && record.revision !== attempt.expected.revision) ||
    record.cardRef?.messageId !== card.messageId ||
    record.cardRef.threadId !== card.threadId ||
    record.cardRef.blockId !== card.blockId
  )
    throw new Error('请求已变化，请重新读取');
  const request = record.request;
  let response;
  try {
    let input: unknown;
    if (request.kind === 'question') input = { kind: 'answers', answers };
    response = parseRuntimeInteractionResponse(request, attempt?.response ?? input);
  } catch {
    throw new Error('请检查必填回答');
  }
  const result = await apiFetch(`/api/runtime-interactions/${encodeURIComponent(id)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardRef: record.cardRef, response }),
  });
  if (!result.ok) throw new Error('回答未提交，请重新读取');
  const next = await readRuntimeRecord(id, undefined, true);
  approvalResultRead.seedFacts(
    { owner: request.owner.userId, producer: 'F306', proposalId: id },
    { native: { interaction: next } },
  );
}

/** Draft paths are data keys, not owner state; punctuation in opaque IDs cannot become path segments. */
export function runtimeFieldKey(id: string, key: string): string {
  return `rt:${encodeURIComponent(id).replaceAll('.', '%2E')}:${encodeURIComponent(key).replaceAll('.', '%2E')}`;
}

export function runtimeResponse(
  record: RuntimeInteractionRecord,
  mid: string,
  draft: Record<string, unknown>,
  decisionId?: string,
  prefix = 'ask',
  values: Record<string, unknown> = {},
): RuntimeInteractionResponse {
  const q = record.request;
  let input: unknown;
  if (q.kind === 'question') {
    const answers: Record<string, string[]> = {};
    for (const row of questionRows(record, mid, draft, prefix)) {
      const free = row.free ? String(draft[row.freeId] ?? '').trim() : '';
      const selected = row.multi
        ? row.opts.filter((o) => o.on).map((o) => o.v)
        : draft[`r-${row.group}`]
          ? [String(draft[`r-${row.group}`])]
          : [];
      answers[row.id] = row.skipped ? [] : free ? (row.multi ? [...selected, free] : [free]) : selected;
    }
    input = { kind: 'answers', answers };
  } else if (q.kind === 'conversation_decision') {
    const selectedIds = (draft[runtimeFieldKey(q.interactionId, 'selected')] ?? []) as string[];
    const customInput = String(draft[runtimeFieldKey(q.interactionId, 'custom')] ?? '').trim();
    input = { kind: 'selection', selectedIds, ...(customInput ? { customInput } : {}) };
  } else {
    const accept = q.decisions.find((d) => d.id === decisionId)?.outcome === 'accept';
    const content =
      q.kind === 'elicitation' && q.mode === 'form' && accept
        ? Object.fromEntries(
            Object.entries(q.requestedSchema.properties).flatMap(([key, field]) => {
              const value = values[key] ?? field.default;
              if (value === undefined || value === '') return [];
              return [
                [
                  key,
                  field.type === 'boolean'
                    ? String(value) === 'true'
                    : field.type === 'string'
                      ? String(value)
                      : Number(value),
                ],
              ];
            }),
          )
        : undefined;
    input = { kind: 'decision', decisionId, ...(content ? { content } : {}) };
  }
  return parseRuntimeInteractionResponse(q, input);
}

export function runtimeAskView(
  binding: QuestionBinding | undefined,
  mid: string,
  draft: Record<string, unknown>,
  values: Record<string, unknown> = {},
) {
  const r = binding?.record;
  if (binding?.failed) return { load: 'error' };
  if (!r) return { load: 'loading' };
  const q = r.request,
    id = q.interactionId;
  const pending = r.status === 'pending' && !!binding?.current;
  const fields =
    pending && q.kind === 'elicitation' && q.mode === 'form'
      ? Object.entries(q.requestedSchema.properties).map(([key, field]) => ({
          interactionId: id,
          key,
          id: `rt-${id}-${key}`,
          type: field.type,
          enum: field.enum,
          value: values[key] ?? field.default,
          label: field.title ?? key,
          help: field.description,
        }))
      : null;
  const block = pending && q.kind === 'conversation_decision' ? q.presentation : null;
  const ids = (draft[runtimeFieldKey(id, 'selected')] ?? []) as string[];
  return {
    load: '',
    id,
    title: q.title,
    description: q.description || ('message' in q ? q.message : ''),
    qs: pending && q.kind === 'question' ? questionRows(r, mid, draft) : null,
    fields,
    url: pending && q.kind === 'elicitation' && q.mode === 'url' ? q.url : '',
    decisions:
      pending && 'decisions' in q ? q.decisions.map((d) => ({ id, v: d.id, label: d.label, outcome: d.outcome })) : [],
    choices: block
      ? block.options.map((o) => ({ v: o.id, label: o.label, sub: o.description, on: ids.includes(o.id) }))
      : null,
    interactiveType: block?.interactiveType,
    group: `rt-${id}`,
    selected: ids[0] ?? '',
    canCustom: !!block?.options.some((o) => o.customInput && ids.includes(o.id)),
    customInput: pending ? String(draft[runtimeFieldKey(id, 'custom')] ?? '') : '',
    customId: `rt-${id}-custom`,
    allowText: !!block && q.kind === 'conversation_decision' && !!q.allowTextResponse,
    result: r.terminal ? runtimeResult(r, mid) : null,
  };
}

function runtimeResult(r: RuntimeInteractionRecord, mid: string) {
  const response = r.terminal!.response,
    q = r.request;
  const selected: string[] = [];
  if (response?.kind === 'answers' && q.kind === 'question') {
    for (const item of q.questions)
      if (!item.isSecret)
        for (const index of response.selectedOptionIndexes?.[item.id] ?? []) {
          const option = item.options?.[index];
          if (option) selected.push(option.label);
        }
  } else if (response?.kind === 'selection' && q.kind === 'conversation_decision') {
    for (const id of response.selectedIds) {
      const option = q.presentation.options.find((o) => o.id === id);
      if (option) selected.push(option.label);
    }
  } else if (response?.kind === 'decision' && 'decisions' in q) {
    const decision = q.decisions.find((d) => d.id === response.decisionId);
    if (decision) selected.push(decision.label);
  }
  const reason = r.terminal!.reasonCode;
  const status =
    reason === 'answered'
      ? 'approved'
      : reason === 'user_rejected'
        ? 'rejected'
        : reason === 'expired'
          ? 'expired'
          : reason === 'withdrawn'
            ? 'withdrawn'
            : r.status === 'declined'
              ? 'rejected'
              : 'closed';
  return { key: `${mid}:result`, status, reason, selected };
}
