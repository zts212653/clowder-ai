import type { MatterWriteInput } from '@cat-cafe/shared';

export interface MatterWriteContent {
  summary: string | undefined;
  initialDescription: string;
  descriptionFromEntry: boolean;
}

/** Admission and persistence share the content's origin, rather than inferring a link from equal text. */
export function normalizeMatterWriteContent(input: MatterWriteInput): MatterWriteContent {
  const summary = 'summary' in input ? input.summary : undefined;
  if (input.operation !== 'create') return { summary, initialDescription: '', descriptionFromEntry: false };
  const description = input.description ?? '';
  if (summary !== undefined) {
    return {
      summary,
      initialDescription: description || summary,
      descriptionFromEntry: description.length === 0,
    };
  }
  // The accepted description-only compatibility input supplies both the entry and its page context.
  if (!input.sources && description.trim().length > 0) {
    return { summary: description.trim(), initialDescription: description, descriptionFromEntry: true };
  }
  return { summary, initialDescription: description, descriptionFromEntry: false };
}
