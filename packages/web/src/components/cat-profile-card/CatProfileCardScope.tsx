'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import type { ConversationViewPreferenceController } from '@/hooks/useConversationViewPreference';
import { buildComposerRecipientIdentities } from '../composer-routing-presentation';
import { CatProfileCard } from './CatProfileCard';
import { CatProfileCardContext } from './CatProfileCardContext';

export function CatProfileCardScope({
  threadId,
  conversationView,
  enabled,
  children,
}: {
  threadId: string;
  conversationView?: ConversationViewPreferenceController;
  enabled: boolean;
  children: ReactNode;
}) {
  const { cats, getCatById } = useCatData();
  const [selected, setSelected] = useState<{ threadId: string; catId: string; anchor: HTMLElement } | null>(null);
  useEffect(() => {
    setSelected((previous) => (enabled && previous?.threadId === threadId ? previous : null));
  }, [threadId, enabled]);
  const insert = useRef<((text: string) => void) | null>(null);
  const [canInsert, setCanInsert] = useState(false);
  const controller = useMemo(
    () => ({
      open: (catId: string, anchor: HTMLElement) =>
        setSelected((previous) =>
          previous?.threadId === threadId && previous.catId === catId && previous.anchor === anchor
            ? null
            : { threadId, catId, anchor },
        ),
      registerComposer: (handler: (text: string) => void) => {
        insert.current = handler;
        setCanInsert(true);
        return () => {
          if (insert.current === handler) {
            insert.current = null;
            setCanInsert(false);
          }
        };
      },
    }),
    [threadId],
  );
  const close = useCallback(() => setSelected(null), []);
  const selection = enabled && selected?.threadId === threadId ? selected : null;
  const cat = selection && getCatById(selection.catId);
  const mention = cat && buildComposerRecipientIdentities(cats).get(cat.id)?.insert;
  return (
    <CatProfileCardContext.Provider value={enabled ? controller : null}>
      {children}
      {cat && selection && (
        <CatProfileCard
          key={cat.id}
          cat={cat}
          threadId={threadId}
          anchor={selection.anchor}
          onClose={close}
          onMention={
            mention && canInsert
              ? () => {
                  insert.current?.(mention);
                  close();
                }
              : undefined
          }
          conversationView={conversationView}
        />
      )}
    </CatProfileCardContext.Provider>
  );
}
