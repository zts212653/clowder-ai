/**
 * F306 Phase C — iCode `_chrys/request_input` → provider-neutral Runtime Interaction.
 *
 * iCode asks the human through a native ask-user request (`_chrys/request_input`,
 * shaped like `{ questions: [{ header?, question, options?, multiSelect? }] }`).
 * This bridge turns that batch into ONE canonical question interaction on the
 * shared RuntimeInteractionPort — so the request becomes a real card in the
 * thread, handled by the same store/waiter/owner-decision lifecycle every other
 * provider uses — and maps the human's answers back onto iCode's strict
 * positional wire result `{ answers: [{ values, note }], cancelled }`.
 *
 * Boundaries:
 *  - malformed batches throw (iCode validates strictly; a protocol mismatch must
 *    surface as an error, not a silent cancel)
 *  - human skip, a cancelled provider turn, and lifecycle withdrawal/expiry map
 *    to `{ cancelled: true }`; host/transport/confirmation failures throw so
 *    iCode sees an honest error instead of a fabricated human decision
 *  - iCode questions are always free-text capable (`isOther`, only when options
 *    exist) and always skippable (`allowUnanswered`) — iCode accepts both
 *    `values: []` and custom text values; batch/option caps mirror iCode's own
 *    validation limits
 */

import type {
  RuntimeInteractionOwner,
  RuntimeInteractionRequest,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import type { RuntimeInteractionPort } from '../../../../../../runtime-interaction/ports/RuntimeInteractionPort.js';
import { RuntimeInteractionError } from '../../../../../../runtime-interaction/RuntimeInteractionError.js';

export const ACP_REQUEST_INPUT_METHOD = '_chrys/request_input';

/**
 * Terminal reasons that mean "the human did not answer" rather than "the host
 * failed to ask". iCode's wire result only has `{cancelled:true}` for that
 * state; everything else must surface as an error instead of pretending the
 * human cancelled.
 *
 * `confirmation_unavailable`, `transport_lost` and `host_restarted` are host
 * failures: the human may have submitted an answer that never became durable,
 * or never saw a live card. They must stay errors on the provider wire.
 */
const REQUEST_INPUT_NO_ANSWER_REASONS = new Set<RuntimeInteractionTerminalReasonCode>([
  'user_rejected',
  'user_cancelled',
  'provider_cancelled',
  'withdrawn',
  'superseded',
  'expired',
]);

/** Mirrors chrys MAX_ASK_USER_QUESTIONS / MAX_ASK_USER_OPTIONS. */
export const MAX_REQUEST_INPUT_QUESTIONS = 5;
export const MAX_REQUEST_INPUT_OPTIONS = 8;
const MAX_QUESTION_CHARS = 10_000;
const MAX_OPTION_LABEL_CHARS = 200;
const HEADER_FALLBACK_CHARS = 120;

export interface AcpRequestInputRequestLike {
  id: string | number;
  params?: unknown;
}

export interface AcpRequestInputContext {
  owner: RuntimeInteractionOwner;
  port: Pick<RuntimeInteractionPort, 'request'>;
  signal?: AbortSignal;
  /** iCode session id — carried as the provider thread coordinate for correlation. */
  providerSessionId?: string;
  createInteractionId?: () => string;
  now?: () => number;
}

export type AcpRequestInputResult =
  | { cancelled: false; answers: Array<{ values: string[]; note: string }> }
  | { cancelled: true };

export interface AcpRequestInputBridge {
  handle(request: AcpRequestInputRequestLike): Promise<AcpRequestInputResult>;
  /** True while at least one interaction for this bridge is still awaiting the human. */
  hasPending(): boolean;
  /** Follow the replacement session on the #1091 retry path. */
  setProviderSessionId(sessionId: string): void;
}

interface ParsedQuestion {
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export function createAcpRequestInputBridge(context: AcpRequestInputContext): AcpRequestInputBridge {
  let pending = 0;
  let providerSessionId = context.providerSessionId;

  return {
    hasPending: () => pending > 0,

    setProviderSessionId(sessionId) {
      providerSessionId = sessionId;
    },

    async handle(request) {
      const parsed = parseRequestInputQuestions(request.params);
      const questions = parsed.map((question, index) => ({
        id: `q${index}`,
        header: (question.header ?? '').trim() || question.question.slice(0, HEADER_FALLBACK_CHARS),
        question: question.question,
        ...(question.options.length > 0 ? { options: question.options } : {}),
        ...(question.multiSelect ? { multiSelect: true } : {}),
        // iCode answers may always carry custom text and may always be skipped.
        // A question without options answers through the main free-text input;
        // isOther would render a second box and split the submitted value.
        ...(question.options.length > 0 ? { isOther: true } : {}),
        allowUnanswered: true,
      }));

      const portRequest: RuntimeInteractionRequest = {
        version: 1,
        interactionId: context.createInteractionId?.() ?? crypto.randomUUID(),
        kind: 'question',
        owner: context.owner,
        provider: {
          providerId: 'chrys',
          method: ACP_REQUEST_INPUT_METHOD,
          requestId: request.id,
          ...(providerSessionId ? { threadId: providerSessionId } : {}),
        },
        createdAt: context.now?.() ?? Date.now(),
        title: 'iCode 需要你的回答',
        questions,
      };

      pending += 1;
      try {
        const response = await context.port.request(
          portRequest,
          context.signal ? { signal: context.signal } : undefined,
        );
        if (response.kind !== 'answers') throw new Error('question interaction requires answers response');
        return {
          cancelled: false,
          answers: questions.map((question) => ({
            values: response.answers[question.id] ?? [],
            note: '',
          })),
        };
      } catch (error) {
        if (error instanceof RuntimeInteractionError && error.reasonCode) {
          if (REQUEST_INPUT_NO_ANSWER_REASONS.has(error.reasonCode)) {
            // Skip / rejected card / aborted turn / invalidated interaction:
            // iCode treats a well-formed cancelled outcome as "no response".
            return { cancelled: true };
          }
        }
        // Infrastructure or protocol failure: the human was never able to
        // answer, so reporting cancelled would invent a human decision.
        throw error;
      } finally {
        pending -= 1;
      }
    },
  };
}

function parseRequestInputQuestions(params: unknown): ParsedQuestion[] {
  if (!isRecord(params)) throw new Error('request_input requires an object payload');
  const rawQuestions = params.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error('request_input requires a non-empty questions array');
  }
  if (rawQuestions.length > MAX_REQUEST_INPUT_QUESTIONS) {
    throw new Error(`request_input has too many questions (max ${MAX_REQUEST_INPUT_QUESTIONS})`);
  }
  return rawQuestions.map((raw, index) => parseRequestInputQuestion(raw, index));
}

function parseRequestInputQuestion(raw: unknown, index: number): ParsedQuestion {
  if (!isRecord(raw)) throw new Error(`request_input question ${index} must be an object`);
  for (const key of Object.keys(raw)) {
    if (key !== 'question' && key !== 'header' && key !== 'options' && key !== 'multiSelect') {
      throw new Error(`request_input question ${index} has unsupported field "${key}"`);
    }
  }
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question) throw new Error(`request_input question ${index} text is required`);
  if (question.length > MAX_QUESTION_CHARS) {
    throw new Error(`request_input question ${index} exceeds ${MAX_QUESTION_CHARS} characters`);
  }
  let header: string | undefined;
  if (raw.header !== undefined) {
    if (typeof raw.header !== 'string') throw new Error(`request_input question ${index} header must be a string`);
    header = raw.header;
  }
  let multiSelect = false;
  if (raw.multiSelect !== undefined) {
    if (typeof raw.multiSelect !== 'boolean') {
      throw new Error(`request_input question ${index} multiSelect must be a boolean`);
    }
    multiSelect = raw.multiSelect;
  }
  const rawOptions = raw.options ?? [];
  if (!Array.isArray(rawOptions)) throw new Error(`request_input question ${index} options must be an array`);
  if (rawOptions.length > MAX_REQUEST_INPUT_OPTIONS) {
    throw new Error(`request_input question ${index} has too many options (max ${MAX_REQUEST_INPUT_OPTIONS})`);
  }
  const options = rawOptions.map((rawOption, optionIndex) => {
    if (!isRecord(rawOption)) {
      throw new Error(`request_input question ${index} option ${optionIndex} must be an object`);
    }
    for (const key of Object.keys(rawOption)) {
      if (key !== 'label' && key !== 'description') {
        throw new Error(`request_input question ${index} option ${optionIndex} has unsupported field "${key}"`);
      }
    }
    const label = typeof rawOption.label === 'string' ? rawOption.label.trim() : '';
    if (!label) throw new Error(`request_input question ${index} option ${optionIndex} label is required`);
    if (label.length > MAX_OPTION_LABEL_CHARS) {
      throw new Error(`request_input question ${index} option ${optionIndex} label is too long`);
    }
    if (rawOption.description !== undefined && typeof rawOption.description !== 'string') {
      throw new Error(`request_input question ${index} option ${optionIndex} description must be a string`);
    }
    return {
      label,
      ...(rawOption.description ? { description: rawOption.description } : {}),
    };
  });
  return { ...(header !== undefined ? { header } : {}), question, options, multiSelect };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
