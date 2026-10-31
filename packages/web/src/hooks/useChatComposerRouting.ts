'use client';

import type { CatId } from '@cat-cafe/shared';
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useMemo, useState } from 'react';
import type { ComposerPreferredCatControl } from '@/components/ComposerPreferredCatSection';
import type { CatOption } from '@/components/chat-input-options';
import { useChatStore } from '@/stores/chatStore';
import { useComposerPreferredCat } from './useComposerPreferredCat';
import { type RoutingPreviewScope, type RoutingPreviewState, useRoutingPreview } from './useRoutingPreview';
import { selectThreadMessages } from './useThreadScopedSelectors';

export interface ProspectiveThreadRouting {
  preferredCats: readonly string[];
  optionsLocked?: boolean;
  onPreferredCatsChange: (catIds: string[]) => void;
}

export function useChatComposerRouting({
  enabled,
  threadId,
  prospectiveThread,
  content,
  setContent,
  textareaRef,
  whisperMode,
  whisperTargets,
  composing,
}: {
  enabled: boolean;
  threadId: string;
  prospectiveThread?: ProspectiveThreadRouting;
  content: string;
  setContent: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  whisperMode: boolean;
  whisperTargets: ReadonlySet<string>;
  composing: boolean;
}) {
  const [previewRevision, setPreviewRevision] = useState(0);
  const refreshPreview = useCallback(() => setPreviewRevision((revision) => revision + 1), []);
  const existingPreferredCat = useComposerPreferredCat(threadId, enabled && !prospectiveThread, refreshPreview);
  const prospectivePreferredKey = prospectiveThread?.preferredCats.join('\u0000') ?? '';
  const prospectivePreferredChange = prospectiveThread?.onPreferredCatsChange;
  const updateProspectivePreferredCat = useCallback(
    async (catIds: string[]) => {
      if (!prospectivePreferredChange) return false;
      prospectivePreferredChange(catIds);
      refreshPreview();
      return true;
    },
    [prospectivePreferredChange, refreshPreview],
  );
  const preferredCatControl: ComposerPreferredCatControl | null = prospectiveThread
    ? {
        selectedCatIds: prospectivePreferredKey ? prospectivePreferredKey.split('\u0000') : [],
        disabled: prospectiveThread.optionsLocked,
        onChange: updateProspectivePreferredCat,
      }
    : existingPreferredCat;
  const historyKey = useChatStore((state) => {
    if (prospectiveThread) return 'prospective';
    const messages = selectThreadMessages(state, threadId);
    const latest = messages[messages.length - 1];
    return `${messages.length}:${latest?.id ?? ''}:${latest?.catId ?? ''}`;
  });
  const scope = useMemo<RoutingPreviewScope | null>(() => {
    if (!enabled) return null;
    if (prospectiveThread) {
      return {
        scope: 'new-thread',
        preferredCats: prospectivePreferredKey ? prospectivePreferredKey.split('\u0000') : [],
      };
    }
    return threadId ? { scope: 'thread', threadId } : null;
  }, [enabled, prospectivePreferredKey, prospectiveThread, threadId]);
  const serverRoutingPreview = useRoutingPreview({
    enabled: enabled && !whisperMode,
    content,
    scope,
    refreshKey: `${historyKey}:${previewRevision}`,
    suspended: composing,
  });
  const routingPreview: RoutingPreviewState =
    enabled && whisperMode
      ? {
          status: 'ready',
          targetCats: [...whisperTargets] as CatId[],
          reason: { kind: 'whisper_recipients' },
        }
      : serverRoutingPreview;
  const insertRecipientMention = useCallback(
    (option: CatOption) => {
      const prefix = option.insert;
      const selectionStart = textareaRef.current?.selectionStart ?? 0;
      const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
      const alreadyVisible = content.startsWith(prefix);
      if (!alreadyVisible) setContent(`${prefix}${content}`);
      window.setTimeout(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        const offset = alreadyVisible ? 0 : prefix.length;
        textarea.setSelectionRange(selectionStart + offset, selectionEnd + offset);
      }, 0);
    },
    [content, setContent, textareaRef],
  );

  return { insertRecipientMention, preferredCatControl, routingPreview };
}
