import type {
  MatterEntryView,
  MatterPage,
  MatterSourceReference,
  MatterWriteInput,
  MatterWriteSnapshot,
  MessageFrom,
} from '@cat-cafe/shared';
import type { StoredMatter, StoredMatterEntry } from './MatterMemoryStore.js';
import { matterDigest } from './matter-source.js';

/** Built inside the canonical write transaction. Only validated input and actual row changes enter the receipt. */
export function matterWriteSnapshot(
  input: MatterWriteInput,
  matter: StoredMatter,
  entries: StoredMatterEntry[],
  sources: MatterSourceReference[],
  before: MatterPage | undefined,
  writer?: MessageFrom,
): MatterWriteSnapshot {
  const inputs =
    input.operation === 'create' || input.operation === 'append'
      ? input.sources
      : input.operation === 'correct' && input.source
        ? [input.source]
        : [];
  const view = (entry: StoredMatterEntry): MatterEntryView => {
    const index = sources.findIndex((source) => matterDigest(source) === matterDigest(entry.source));
    const original = inputs?.[index];
    return {
      ...entry,
      sourceStatus: 'kind' in entry.source && entry.source.kind === 'thread' ? 'thread_only' : 'current',
      attribution: !('kind' in entry.source) && entry.source.segment === 'quote_text' ? 'quoted_in_message' : 'author',
      ...(original && 'quote' in original ? { quote: original.quote } : {}),
    };
  };
  const oldEntry = 'entryId' in input ? before?.entries.find((entry) => entry.entryId === input.entryId) : undefined;
  const replaced = oldEntry ? entries.find((entry) => entry.entryId === oldEntry.entryId)?.supersededBy : undefined;
  const affected =
    input.operation === 'correct'
      ? entries.filter((entry) => entry.entryId === replaced)
      : input.operation === 'create' || input.operation === 'append'
        ? entries.filter((entry) => !before?.entries.some((old) => old.entryId === entry.entryId))
        : [];
  return {
    operation: input.operation,
    matter: { matterId: matter.matterId, title: matter.title, revision: matter.revision },
    recordedAt: matter.updatedAt,
    ...(writer ? { writer } : {}),
    ...(input.operation === 'edit' && before && input.title !== before.matter.title
      ? { titleChange: { before: before.matter.title, after: input.title } }
      : {}),
    ...((input.operation === 'edit' && before && input.description !== before.matter.description) ||
    (input.operation === 'create' && matter.description)
      ? {
          descriptionChange: {
            before: before?.matter.description ?? '',
            after: matter.description,
            ...(matter.descriptionAuthor ? { author: matter.descriptionAuthor } : {}),
          },
        }
      : {}),
    entries: input.operation === 'retire_entry' && oldEntry ? [{ ...oldEntry, status: 'retired' }] : affected.map(view),
    ...(input.operation === 'correct' && oldEntry ? { previousEntries: [oldEntry] } : {}),
  };
}

/** Fixed write content still depends on current source permissions and source validity. */
export function revalidateMatterWriteSnapshot(snapshot: MatterWriteSnapshot, page: MatterPage): MatterWriteSnapshot {
  const entry = (saved: MatterEntryView): MatterEntryView => {
    const current = page.entries.find((item) => item.entryId === saved.entryId);
    const { quote, verifiedQuotedAuthor: _oldAuthor, ...rest } = saved;
    return {
      ...rest,
      sourceStatus: current?.sourceStatus ?? 'changed',
      ...(current && current.sourceStatus !== 'changed' && quote ? { quote } : {}),
      ...(current?.verifiedQuotedAuthor ? { verifiedQuotedAuthor: current.verifiedQuotedAuthor } : {}),
    };
  };
  return {
    ...snapshot,
    ...(page.entries.some((entry) => entry.sourceStatus === 'changed') ? { sourcesChanged: true } : {}),
    entries: snapshot.entries.map(entry),
    ...(snapshot.previousEntries ? { previousEntries: snapshot.previousEntries.map(entry) } : {}),
  };
}
