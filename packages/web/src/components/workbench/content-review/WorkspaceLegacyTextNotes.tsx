import { useState } from 'react';
import { SelectionAnnotationAction } from '@/components/SelectionAnnotationAction';
import type { FloatingSelectionPosition } from '@/components/workspace/selection-action-position';
import { addWorkspaceFileQuoteToChat } from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import type {
  LegacyTextItem,
  LegacyTextLocal,
  LegacyTextNotes,
  LegacyTextOutcome,
} from './workspace-review-legacy-text';

type DraftItem = Extract<LegacyTextItem, { kind: 'draft' }>;
const UNKNOWN = '保存结果仍无法确认：原请求可能还会生效，所以不会重发。正文原样保留，稍后再核对。';
const OWNER = { saved: '这条批注当时已经保存', unsaved: '已确认这条批注没有保存' } as const;
/** The owner's answer and what this browser managed to record are reported separately, never merged. */
function reconcileStatus(owner: LegacyTextOutcome, local: LegacyTextLocal | null): string {
  if (owner.kind === 'unknown' || !local) return UNKNOWN;
  const heard = OWNER[owner.kind];
  if (local === 'stale') return `${heard}；但这份草稿在核对期间被别处改动过，本地没有改它，请再核对一次。`;
  if (local === 'failed') return `${heard}；但浏览器没能记下这个结果，它仍显示为待核对，正文没有丢。`;
  return owner.kind === 'saved' ? `${heard}，已回到原记录。` : `${heard}。正文已保留，可以续到批注卡。`;
}
const CONTINUED: Record<LegacyTextLocal, string> = {
  settled: '已放进当前聊天输入框；发送前可以展开核对。',
  stale: '已放进当前聊天输入框；这份草稿刚在别处改动过，所以没有清除它，请核对。',
  failed: '已放进当前聊天输入框，但浏览器没能标记这份旧草稿已续写，它会继续显示在这里。',
};

/**
 * Text left by the retired F309 composer. Nothing is re-sent from here: an unconfirmed save is checked by
 * its operation, and unsaved text continues into the same selection card → chat chip.
 */
export function WorkspaceLegacyTextNotes({
  legacy,
  locator,
  markdown,
  currentRevision,
  onShowRecord,
}: {
  readonly legacy: LegacyTextNotes;
  readonly locator: { readonly worktreeId: string; readonly path: string };
  readonly markdown: boolean;
  readonly currentRevision: string;
  readonly onShowRecord: (annotationId: string) => void;
}) {
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [continuing, setContinuing] = useState<{ item: DraftItem; position: FloatingSelectionPosition } | null>(null);
  if (legacy.items.length === 0 && legacy.unreadable === 0 && !status) return null;
  const check = async (item: Extract<LegacyTextItem, { kind: 'pending' }>) => {
    setChecking(true);
    setStatus(null);
    try {
      const { owner, local } = await legacy.reconcile(item);
      setStatus(reconcileStatus(owner, local));
      if (owner.kind === 'saved' && owner.annotationId && local === 'settled') onShowRecord(owner.annotationId);
    } finally {
      setChecking(false);
    }
  };
  return (
    <section
      aria-label="旧文本批注"
      data-testid="workspace-legacy-text-notes"
      className="mx-3 mb-2 space-y-2 rounded border border-cafe-subtle bg-cafe-surface p-3 text-xs text-cafe"
    >
      {status ? <p role="status">{status}</p> : null}
      {legacy.items.map((item) => (
        <article
          key={`${item.key}:${item.kind}`}
          data-testid="workspace-legacy-text-note"
          data-legacy-kind={item.kind}
          className="space-y-1"
        >
          <p className="font-semibold">
            {item.kind === 'pending' ? '一条旧批注的保存结果还没确认' : '一条之前没有提交的批注草稿'}
          </p>
          <blockquote className="line-clamp-3 whitespace-pre-wrap border-l-2 border-cafe-subtle pl-2 text-cafe-muted">
            {item.quote}
          </blockquote>
          <p className="whitespace-pre-wrap">{item.body.trim()}</p>
          {item.sourceRevision !== currentRevision ? (
            <p className="text-cafe-muted">这条写于文件的旧版本；文件已经改动，引用的原文可能已不在当前版本里。</p>
          ) : null}
          {item.kind === 'pending' ? (
            <button
              type="button"
              disabled={checking}
              onClick={() => void check(item)}
              className="font-semibold text-cafe-accent disabled:opacity-50"
            >
              {checking ? '正在核对…' : '核对保存结果'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="workspace-legacy-text-continue"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setStatus(null);
                setContinuing({ item, position: { top: box.bottom + 8, left: box.left } });
              }}
              className="font-semibold text-cafe-accent"
            >
              续到批注卡
            </button>
          )}
        </article>
      ))}
      {legacy.unreadable > 0 ? (
        <p className="text-cafe-muted">
          浏览器里还有 {legacy.unreadable} 份旧批注草稿无法读取；它们原样保留，没有改动。
        </p>
      ) : null}
      {continuing ? (
        <SelectionAnnotationAction
          selectedText={continuing.item.quote}
          initialComment={continuing.item.body.trim()}
          initialEditing
          position={continuing.position}
          positionMode="fixed"
          actionTestId="workspace-legacy-text-card"
          onClose={() => setContinuing(null)}
          onSave={(comment) => {
            // The person's card is their explicit intent, so the chip is added; the old draft is cleared only
            // if it is still the exact text the card was opened from.
            addWorkspaceFileQuoteToChat(currentThreadId, {
              text: continuing.item.quote,
              comment,
              path: locator.path,
              worktreeId: locator.worktreeId,
              language: markdown ? 'markdown' : null,
            });
            setStatus(CONTINUED[legacy.continued(continuing.item)]);
          }}
        />
      ) : null}
    </section>
  );
}
