'use client';
import { type RichCardBlock, type WorkReference, workReferenceCardSchema, workReferenceSchema } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { MarkdownContent } from '../MarkdownContent';

const descriptionSchema = z.object({
  asset: workReferenceSchema.passthrough(),
  currentOwnerRevision: z.number().int().positive().safe(),
});
async function readCardVersion(reference: WorkReference, current: boolean) {
  const query = current ? '' : `?ownerRevision=${reference.ownerRevision}`;
  const response = await apiFetch(`/api/content-publications/${encodeURIComponent(reference.contentRef)}${query}`);
  if (!response.ok) throw new Error('原作品暂时无法打开，请保留这条引用后重试。');
  const result = descriptionSchema.parse(await response.json());
  const revision = current ? result.currentOwnerRevision : reference.ownerRevision;
  if (
    result.asset.contentRef !== reference.contentRef ||
    result.asset.ownerRevision !== revision ||
    result.currentOwnerRevision < revision
  )
    throw new Error('原作品版本暂时无法核对，没有换成其它版本。');
  return { revision, latest: result.currentOwnerRevision };
}

function openCardInWorkspace(
  reference: WorkReference,
  revision: number,
  title: string,
  threadId: string,
  messageId?: string,
) {
  captureChatReadingBeforeLayoutChange();
  return useChatStore.getState().openPublication(
    {
      kind: 'publication',
      ...reference,
      ownerRevision: revision,
      title,
      ...(messageId ? { navigationOrigin: { kind: 'chat-file-link' as const, threadId, messageId } } : {}),
    },
    threadId,
    'work-mode',
  );
}
const failureMessage = (failure: unknown) => (failure instanceof Error ? failure.message : '原作品暂时无法打开。');

/** Presentation is pinned; every click resolves the named owner under the current reader's authority. */
export function LivingWorkCard({ block, messageId }: { block: RichCardBlock; messageId?: string }) {
  const parsed = workReferenceCardSchema.safeParse(block);
  return parsed.success ? (
    <FixedWorkCard block={parsed.data} messageId={messageId} />
  ) : (
    <p role="alert">作品引用暂时无法核对。</p>
  );
}

function FixedWorkCard({
  block,
  messageId,
}: {
  block: ReturnType<typeof workReferenceCardSchema.parse>;
  messageId?: string;
}) {
  const reference = block.meta.reference;
  const [latest, setLatest] = useState(reference.ownerRevision);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const open = async (current: boolean) => {
    const threadId = useChatStore.getState().currentThreadId;
    if (!threadId) return;
    const ticket = ++sequence.current;
    const valid = () => ticket === sequence.current && useChatStore.getState().currentThreadId === threadId;
    setBusy(true);
    setError(null);
    try {
      const { revision, latest } = await readCardVersion(reference, current);
      if (!valid()) return;
      setLatest(latest);
      const opened = openCardInWorkspace(reference, revision, block.title, threadId, messageId);
      if (!opened) throw new Error('原作品暂时无法打开，请重试。');
    } catch (failure) {
      if (valid()) setError(failureMessage(failure));
    } finally {
      if (valid()) setBusy(false);
    }
  };
  return (
    <section
      className="my-2 rounded-xl border border-cafe-subtle bg-cafe-surface p-4"
      data-work-reference={JSON.stringify(reference)}
    >
      <h3 className="font-medium">{block.title}</h3>
      <p className="mt-1 text-xs text-cafe-muted">第 {reference.ownerRevision} 版</p>
      <MarkdownContent content={block.bodyMarkdown} />
      <div className="mt-3 flex items-center gap-3 text-xs">
        <button
          type="button"
          disabled={busy}
          onClick={() => void open(false)}
          className="rounded-md bg-cafe-accent px-3 py-1 text-white"
        >
          看这版 · 标意见
        </button>
        <button type="button" disabled={busy} onClick={() => void open(true)}>
          查看最新{latest > reference.ownerRevision ? ` · 第 ${latest} 版` : ''}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-cafe-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
