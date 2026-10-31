import { z } from 'zod';
import { entrustedWorkTaskRefV1Schema } from './growing.js';
import { isValidRichBlock, type RichInteractiveBlock } from './rich.js';

const nonBlank = z.string().trim().min(1);
const boundedAnswerText = z.string().trim().min(1).max(100_000);

export const runtimeConversationSelectionResponseSchema = z
  .object({
    kind: z.literal('selection'),
    selectedIds: z.array(nonBlank).min(1),
    customInput: boundedAnswerText.optional(),
  })
  .strict();

export const runtimeConversationTextResponseSchema = z
  .object({
    kind: z.literal('text'),
    text: boundedAnswerText,
  })
  .strict();

export const runtimeConversationResponseSchema = z.discriminatedUnion('kind', [
  runtimeConversationSelectionResponseSchema,
  runtimeConversationTextResponseSchema,
]);

const interactivePresentationSchema = z.custom<RichInteractiveBlock>(
  (value) => isValidRichBlock(value) && value.kind === 'interactive',
  'conversation decision requires one valid interactive rich block',
);

export const runtimeConversationDecisionRequestSchema = z
  .object({
    version: z.literal(1),
    interactionId: nonBlank,
    kind: z.literal('conversation_decision'),
    owner: z
      .object({
        userId: nonBlank,
        threadId: nonBlank,
        catId: nonBlank,
        invocationId: nonBlank,
      })
      .strict(),
    createdAt: z.number().int().nonnegative(),
    title: nonBlank,
    description: z.string().optional(),
    entrustedWorkTaskRef: entrustedWorkTaskRefV1Schema.optional(),
    presentation: interactivePresentationSchema,
    allowTextResponse: z.boolean(),
    deadlineAt: z.number().int().positive().optional(),
    defaultResponse: runtimeConversationResponseSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const optionIds = request.presentation.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['presentation', 'options'],
        message: 'conversation decision option ids must be unique',
      });
    }
    if (request.presentation.options.some((option) => option.action)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['presentation', 'options'],
        message: 'callback/guide/action options cannot become conversation decisions',
      });
    }
    if (request.presentation.groupId || request.presentation.autoGroup === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['presentation'],
        message: 'one conversation decision must own one independently submitted block',
      });
    }
    if (request.presentation.disabled === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['presentation', 'disabled'],
        message: 'conversation decision presentation must be actionable when published',
      });
    }
    if (request.deadlineAt !== undefined && request.deadlineAt <= request.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadlineAt'],
        message: 'deadlineAt must be later than createdAt',
      });
    }
    if (request.defaultResponse !== undefined && request.deadlineAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultResponse'],
        message: 'defaultResponse requires deadlineAt',
      });
    }
    if (request.defaultResponse) {
      addResponseIssues(request, request.defaultResponse, context, ['defaultResponse']);
    }
  });

export type RuntimeConversationDecisionRequest = z.infer<typeof runtimeConversationDecisionRequestSchema>;
export type RuntimeConversationResponse = z.infer<typeof runtimeConversationResponseSchema>;

export type RuntimeConversationRedactedResponse =
  | { kind: 'selection'; selectedIds: string[]; hasCustomInput?: true }
  | { kind: 'text' };

export function parseRuntimeConversationResponse(
  request: RuntimeConversationDecisionRequest,
  input: unknown,
): RuntimeConversationResponse {
  const response = runtimeConversationResponseSchema.parse(input);
  const issues: z.ZodIssue[] = [];
  addResponseIssues(
    request,
    response,
    { addIssue: (issue: z.IssueData) => issues.push(issue as z.ZodIssue), path: [] } as unknown as z.RefinementCtx,
    [],
  );
  if (issues.length > 0) throw new z.ZodError(issues);
  return response;
}

export function redactRuntimeConversationResponse(
  response: RuntimeConversationResponse,
): RuntimeConversationRedactedResponse {
  if (response.kind === 'text') return { kind: 'text' };
  return {
    kind: 'selection',
    selectedIds: [...response.selectedIds],
    ...(response.customInput ? { hasCustomInput: true as const } : {}),
  };
}

export function renderRuntimeConversationResponse(
  request: RuntimeConversationDecisionRequest,
  response: RuntimeConversationResponse,
): string {
  if (response.kind === 'text') return response.text;
  const block = request.presentation;
  if (block.interactiveType === 'confirm') {
    const confirmId = block.options.find((option) => option.id === '__confirm__')?.id ?? block.options[0]?.id;
    const action = response.selectedIds[0] === confirmId ? '确认' : '取消';
    return block.title ? `${action} — ${block.title}` : action;
  }
  const labels = response.selectedIds.map((id) => {
    const option = block.options.find((candidate) => candidate.id === id);
    if (!option) throw new Error(`conversation selection ${id} is not present in the canonical block`);
    return option.emoji ? `${option.emoji} ${option.label}` : option.label;
  });
  if (response.customInput) {
    const base = labels.length > 0 ? `${labels.join(', ')}：${response.customInput}` : response.customInput;
    return block.title ? `${base}（${block.title}）` : base;
  }
  if (block.messageTemplate) return block.messageTemplate.replace('{selection}', labels.join(', '));
  const base = `我选了：${labels.join(', ')}`;
  return block.title ? `${base}（${block.title}）` : base;
}

function addResponseIssues(
  request: RuntimeConversationDecisionRequest,
  response: RuntimeConversationResponse,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (response.kind === 'text') {
    if (!request.allowTextResponse) {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'text response is not allowed' });
    }
    return;
  }
  const ids = response.selectedIds;
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'selectedIds must be unique' });
  }
  const options = new Map(request.presentation.options.map((option) => [option.id, option]));
  if (ids.some((id) => !options.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'selection contains an unknown option' });
  }
  const limit =
    request.presentation.interactiveType === 'multi-select' ? (request.presentation.maxSelect ?? ids.length) : 1;
  if (ids.length > limit || (request.presentation.interactiveType !== 'multi-select' && ids.length !== 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'selection count exceeds the block contract' });
  }
  if (response.customInput && !ids.some((id) => options.get(id)?.customInput)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'custom input requires a selected custom option' });
  }
}
