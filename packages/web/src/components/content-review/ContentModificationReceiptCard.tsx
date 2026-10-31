import type { ContentModificationReceiptV1 } from '@cat-cafe/shared';
import { formatCatName } from '@/hooks/useCatData';
import { ModificationProgressRow } from './ModificationProgressRow';
import { describeModificationReceipt } from './modification-receipt-copy';
import { useOpenModificationFile } from './useOpenModificationFile';

/**
 * A Host receipt in the conversation (candidate, rejection, write-back), drawn as one plain line in the accepted
 * wording instead of the stored message text, which carries the request, candidate and receipt coordinates. The
 * line opens the original file on demand and never impersonates a person or a cat.
 */
export function ContentModificationReceiptCard({
  receipt,
  messageId,
  getCatById,
}: {
  receipt: ContentModificationReceiptV1;
  messageId: string;
  /** The conversation's own lookup, so the name matches what the rest of the chat shows. */
  getCatById: (id: string) => { displayName: string; variantLabel?: string } | undefined;
}) {
  const cat = getCatById(receipt.targetCatId);
  const copy = describeModificationReceipt({ receipt, ...(cat ? { targetName: formatCatName(cat) } : {}) });
  const opener = useOpenModificationFile({
    requestId: receipt.requestId,
    messageId,
    comparison: copy.action?.kind === 'open-comparison',
    candidateRef: receipt.candidateRef,
  });
  return (
    <div data-message-id={messageId} className="mb-3 flex justify-center">
      <div className="w-full max-w-md">
        <ModificationProgressRow
          copy={copy}
          busy={opener.busy}
          notice={opener.notice}
          handlers={{ 'open-comparison': () => void opener.open(), 'open-file': () => void opener.open() }}
        />
      </div>
    </div>
  );
}
