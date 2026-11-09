/** Extract explicit task markers without starting a model invocation. */
import type { CatId, CreateTaskInput } from '@cat-cafe/shared';
import type { StoredMessage } from '../stores/ports/MessageStore.js';

export interface ExtractedTask {
  title: string;
  why: string;
  ownerCatId?: CatId | null;
  sourceMessageId?: string;
}

export interface ExtractionOptions {
  /** Max messages to analyze (default: 50). */
  maxMessages?: number;
}

export interface ExtractionResult {
  tasks: ExtractedTask[];
  /** Retained response field: deterministic extraction is the normal mode. */
  degraded: false;
}

const TASK_MARKER =
  /(?:^|\s)(?:[-*+][ \t]+\[ \][ \t]*|(?:TODO\b|Action Item\b)(?:[:：]|[ \t]+)[ \t]*|#task[ \t]+)(.+)/i;
const NESTED_MARKER = /^(?:(?:TODO\b|Action Item\b)(?:[:：]|[ \t]+)[ \t]*|#task[ \t]+)/i;

/** Preserve source coordinates; explicit extraction does not infer assignment. */
export function extractTasks(messages: StoredMessage[], options: ExtractionOptions = {}): ExtractionResult {
  const limit = Math.max(0, Math.floor(options.maxMessages ?? 50));
  const recentMessages = limit === 0 ? [] : messages.slice(-limit);
  const tasks: ExtractedTask[] = [];
  for (const message of recentMessages) {
    const seen = new Set<string>();
    for (const line of message.content.split(/\r?\n/)) {
      if (/^\s*[-*+]\s+\[[xX]\]/.test(line)) continue;
      const match = TASK_MARKER.exec(line);
      const title = match?.[1]?.replace(NESTED_MARKER, '').trim();
      if (!title || title.length > 200 || seen.has(title)) continue;
      seen.add(title);
      tasks.push({ title, why: 'Extracted from conversation', sourceMessageId: message.id });
    }
  }
  return { tasks, degraded: false };
}

/**
 * Convert extracted tasks to CreateTaskInput for storage.
 */
export function toCreateTaskInputs(
  extracted: ExtractedTask[],
  threadId: string,
  createdBy: CatId | 'user',
): CreateTaskInput[] {
  return extracted.map((task) => {
    const base = {
      threadId,
      title: task.title,
      why: task.why,
      createdBy,
      ownerCatId: task.ownerCatId ?? null,
    };
    // Only add sourceMessageId if present
    if (task.sourceMessageId) {
      return { ...base, sourceMessageId: task.sourceMessageId } as CreateTaskInput;
    }
    return base as CreateTaskInput;
  });
}
