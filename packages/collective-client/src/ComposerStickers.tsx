import { MESSAGE_STICKER_CATALOG, messageStickerReference } from '@cat-cafe/shared';
import { StickerPicker } from '@cat-cafe/ui';
import { useCallback } from 'react';
import { useCollectiveLanguage } from './collective-copy.js';
import { useMessageExpression } from './message-expression-context.js';
import type { useComposerAttachments } from './use-composer-attachments.js';

export function ComposerStickers({
  channelId,
  files,
  onClose,
}: {
  channelId: string;
  files: ReturnType<typeof useComposerAttachments>;
  onClose: () => void;
}) {
  const port = useMessageExpression();
  const language = useCollectiveLanguage();
  const readImage = useCallback(
    async (id: string, signal: AbortSignal) => {
      if (!port?.catalogImage) throw new Error('Sticker images are unavailable');
      return port.catalogImage(id, channelId, signal);
    },
    [port, channelId],
  );
  return (
    <StickerPicker
      language={language}
      choices={MESSAGE_STICKER_CATALOG.map((entry) => ({
        id: entry.id,
        label: entry.label[language],
        group: entry.label[language].split(' · ')[1],
      }))}
      readImage={readImage}
      onClose={onClose}
      onSelect={async (id, blob) => {
        await files.add([new File([blob], `${id}.png`, { type: 'image/png' })], messageStickerReference(id));
        onClose();
      }}
    />
  );
}
