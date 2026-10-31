import type { MessageContent, QuoteContextAttachment, WorkspaceFileQuoteSource } from '@cat-cafe/shared';

/** What the chat line of a text request says about the work: the file, and how many places of it the message covers. */
export interface TextRequestSubject {
  title: string;
  placeCount: number;
}

type FileQuote = QuoteContextAttachment & { source: WorkspaceFileQuoteSource };

const isFileQuote = (attachment: { kind: string; source?: { kind?: string } }): attachment is FileQuote =>
  attachment.kind === 'quote' && attachment.source?.kind === 'workspace_file';

/**
 * The text work a sent message can have been taken over for, mirroring what the owner accepts when a cat takes a Human
 * message over (`message-takeover.ts`): at least one place quoted from a file, each naming its worktree and the exact
 * version, all of one file at one version, and no picture in the same message (a picture message is the picture
 * path's). For any other message no request can ever exist, so nothing is asked and nothing is shown. A message the
 * owner would still refuse for a reason this cannot see (a file type it does not edit) simply finds no request.
 */
export function textRequestSubjectOf(blocks: readonly MessageContent[] | undefined): TextRequestSubject | null {
  const attachments = (blocks ?? []).flatMap((block) =>
    block.type === 'context_attachment' ? [block.attachment] : [],
  );
  if (attachments.some((attachment) => attachment.kind === 'media')) return null;
  const quotes = attachments.filter(isFileQuote);
  const first = quotes[0]?.source;
  if (!first?.worktreeId || !first.revision) return null;
  const sameVersion = quotes.every(
    ({ source }) =>
      source.worktreeId === first.worktreeId && source.path === first.path && source.revision === first.revision,
  );
  if (!sameVersion) return null;
  return { title: first.path.split('/').filter(Boolean).at(-1) ?? first.path, placeCount: quotes.length };
}
