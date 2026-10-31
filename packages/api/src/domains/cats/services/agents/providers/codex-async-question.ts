import { createHash } from 'node:crypto';
import type { CatId, RichInteractiveBlock } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

interface CodexAsyncQuestion {
  title: string;
  options: string[];
}

const MAX_ASYNC_QUESTIONS = 10;
const MAX_ASYNC_QUESTION_OPTIONS = 10;
const MAX_ASYNC_QUESTION_TITLE_LENGTH = 2_000;
const MAX_ASYNC_QUESTION_OPTION_LENGTH = 500;

function normalizeSingleLineText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, maxLength).trim();
}

function normalizeCodexAsyncQuestions(item: Record<string, unknown>): CodexAsyncQuestion[] {
  if (item.delivery !== 'async' || !Array.isArray(item.questions)) return [];

  return item.questions.slice(0, MAX_ASYNC_QUESTIONS).flatMap((question) => {
    if (typeof question !== 'object' || question === null) return [];
    const raw = question as Record<string, unknown>;
    const title =
      typeof raw.title === 'string' ? normalizeSingleLineText(raw.title, MAX_ASYNC_QUESTION_TITLE_LENGTH) : '';
    if (!title) return [];

    const seenOptions = new Set<string>();
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .flatMap((option) =>
        typeof option === 'string'
          ? [normalizeSingleLineText(option, MAX_ASYNC_QUESTION_OPTION_LENGTH)].filter(Boolean)
          : [],
      )
      .filter((option) => {
        if (seenOptions.has(option)) return false;
        seenOptions.add(option);
        return true;
      })
      .slice(0, MAX_ASYNC_QUESTION_OPTIONS);
    return [{ title, options }];
  });
}

function stableAsyncQuestionItemId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const readable = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
  return `${readable || 'item'}-${digest}`;
}

/**
 * Convert a provider-native async question into durable chat controls.
 * Codex does not wait for a response: selecting an option uses the ordinary
 * interactive-block path, which sends a new user message to the same thread.
 */
export function buildCodexAsyncQuestionMessages(item: Record<string, unknown>, catId: CatId): AgentMessage[] {
  const questions = normalizeCodexAsyncQuestions(item);
  if (questions.length === 0) return [];

  const itemId = stableAsyncQuestionItemId(item.id);
  if (!itemId) return [];
  const groupId = questions.length > 1 ? `codex-async-question-${itemId}` : undefined;

  return questions.map((question, questionIndex) => {
    const questionNumber = questionIndex + 1;
    const declaredOptions = question.options.map((label, optionIndex) => ({
      id: `q${questionNumber}-o${optionIndex + 1}`,
      label,
    }));
    const options =
      declaredOptions.length > 0
        ? [
            ...declaredOptions,
            {
              id: `q${questionNumber}-custom`,
              label: '其他回答',
              customInput: true,
              customInputPlaceholder: '输入你的回答…',
            },
          ]
        : [
            {
              id: `q${questionNumber}-custom`,
              label: '输入回答',
              customInput: true,
              customInputPlaceholder: '输入你的回答…',
            },
          ];
    const block: RichInteractiveBlock = {
      id: `codex-async-question-${itemId}-${questionNumber}`,
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      title: question.title,
      description: '提交后会作为一条新的用户消息发送到当前对话。',
      options,
      autoGroup: false,
      ...(groupId ? { groupId } : {}),
    };

    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'rich_block', block }),
      timestamp: Date.now(),
    };
  });
}
