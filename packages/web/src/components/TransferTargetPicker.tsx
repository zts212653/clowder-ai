'use client';

import type { MessageBundleSelectionItem } from '@cat-cafe/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCatData } from '@/hooks/useCatData';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import {
  createForwardIdempotencyKey,
  forwardPayloadFingerprint,
  submitMessageBundleForward,
} from './message-bundle-forwarding';
import { TransferTargetPickerView } from './TransferTargetPickerView';
import { useTransferTargetPickerLifecycle } from './useTransferTargetPickerLifecycle';

interface TransferTargetPickerProps {
  open: boolean;
  /** Fail-closed admission decided by the owning browser document. */
  admissionBlocked: boolean;
  sourceThreadId: string;
  items: readonly MessageBundleSelectionItem[];
  onClose: () => void;
  onSuccess: (result: { targetThreadId: string; messageBundleId: string }) => void;
}

export function TransferTargetPicker({
  open,
  admissionBlocked,
  sourceThreadId,
  items,
  onClose,
  onSuccess,
}: TransferTargetPickerProps) {
  const isDesktop = useIsDesktop();
  const threads = useChatStore((state) => state.threads);
  const { cats } = useCatData();
  const [targetThreadId, setTargetThreadId] = useState<string | null>(null);
  const [targetCats, setTargetCats] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const retryKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const availableThreads = useMemo(
    () => threads.filter((thread) => thread.id !== sourceThreadId && !thread.deletedAt),
    [sourceThreadId, threads],
  );
  const targetThread = targetThreadId ? threads.find((thread) => thread.id === targetThreadId) : undefined;
  const backToThreads = useCallback(() => {
    setTargetThreadId(null);
    setTargetCats(new Set());
    setError(null);
  }, []);
  const resetPicker = useCallback(() => {
    backToThreads();
    setNote('');
    setSubmitting(false);
    retryKeyRef.current = null;
  }, [backToThreads]);
  const { close, restoreFocus } = useTransferTargetPickerLifecycle({
    open: open && !admissionBlocked,
    atCatStep: targetThreadId !== null,
    panelRef,
    resetPicker,
    backToThreads,
    onClose,
  });
  const toggleCat = useCallback((catId: string) => {
    setTargetCats((current) => {
      const next = new Set(current);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    if (admissionBlocked || !targetThreadId || targetCats.size === 0 || submitting) return;
    const selectedCats = [...targetCats].sort();
    const payload = {
      sourceThreadId,
      targetThreadId,
      targetCats: selectedCats,
      ...(note.trim() ? { note: note.trim() } : {}),
      items,
    };
    const fingerprint = forwardPayloadFingerprint(payload);
    const idempotencyKey =
      retryKeyRef.current?.fingerprint === fingerprint ? retryKeyRef.current.key : createForwardIdempotencyKey();
    retryKeyRef.current = { fingerprint, key: idempotencyKey };
    setSubmitting(true);
    setError(null);
    try {
      const messageBundleId = await submitMessageBundleForward(payload, idempotencyKey);
      useToastStore.getState().addToast({
        type: 'success',
        title: `已转发到「${targetThread?.title ?? '未命名对话'}」`,
        message: `已唤醒 ${selectedCats.length} 只猫猫`,
        duration: 6000,
        action: { label: '查看', threadId: targetThreadId, messageId: messageBundleId },
      });
      onSuccess({ targetThreadId, messageBundleId });
      restoreFocus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '转发失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }, [
    admissionBlocked,
    items,
    note,
    onSuccess,
    restoreFocus,
    sourceThreadId,
    submitting,
    targetCats,
    targetThread,
    targetThreadId,
  ]);

  if (!open || admissionBlocked || typeof document === 'undefined') return null;
  return createPortal(
    <TransferTargetPickerView
      isDesktop={isDesktop}
      panelRef={panelRef}
      targetThreadId={targetThreadId}
      targetThreadTitle={targetThread?.title}
      availableThreads={availableThreads}
      cats={cats}
      targetCats={targetCats}
      note={note}
      error={error}
      submitting={submitting}
      itemCount={items.length}
      singleItemLabel={
        items.length === 1 && (items[0]?.kind === 'quote' || items[0]?.kind === 'cli_quote')
          ? '1 段引用'
          : items.length === 1 && items[0]?.kind === 'rich_block'
            ? '1 个富块'
            : undefined
      }
      onClose={close}
      onBack={backToThreads}
      onSelectThread={setTargetThreadId}
      onToggleCat={toggleCat}
      onNoteChange={setNote}
      onSubmit={() => void submit()}
    />,
    document.body,
  );
}
