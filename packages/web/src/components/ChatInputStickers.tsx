'use client';

import { MESSAGE_STICKER_CATALOG } from '@cat-cafe/shared';
import { StickerPicker } from '@cat-cafe/ui';
import { apiFetch } from '@/utils/api-client';
import { useShellLanguage } from './shell/shell-language';

async function readImage(id: string, signal: AbortSignal) {
  const response = await apiFetch(`/api/message-stickers/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) throw new Error('Original sticker image unavailable');
  return response.blob();
}

export function ChatInputStickers({
  onSelect,
  onClose,
}: {
  readonly onSelect: (file: File) => void;
  readonly onClose: () => void;
}) {
  const language = useShellLanguage();
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
      onSelect={(id, image) => {
        onSelect(new File([image], `${id}.png`, { type: 'image/png' }));
        onClose();
      }}
    />
  );
}
