'use client';
import {
  type ArtifactReviewDrawing,
  type ImmutableMedia,
  REVIEW_MARK_COLORS as MARKUP_COLORS,
  REVIEW_MARK_STROKE_WIDTHS as MARKUP_STROKE_WIDTHS,
  MAX_REVIEW_DRAFT_MARKS as MAX_MARKS,
  MAX_REVIEW_STROKE_POINTS as MAX_STROKE_POINTS,
  artifactReviewDrawingSchema as markSchema,
  reviewDrawingFitsMedia,
} from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { z } from 'zod';

export { MARKUP_COLORS, MARKUP_STROKE_WIDTHS, MAX_MARKS, MAX_STROKE_POINTS };
export type ReviewMarkupTool = 'select' | 'brush' | 'rectangle' | 'ellipse' | 'arrow' | 'text' | 'eraser';
export type ReviewMarkupFrame = NonNullable<ArtifactReviewDrawing['frame']>;
export type ReviewMarkupMark = ArtifactReviewDrawing;
export type ReviewMarkupHistory = {
  past: ReviewMarkupMark[][];
  current: ReviewMarkupMark[];
  future: ReviewMarkupMark[][];
};
const MAX_HISTORY = 30;
const NO_CONFIRMED_MARKS: ReviewMarkupMark[] = [];

const persistedDraftSchema = z.object({ v: z.literal(1), marks: z.array(markSchema).max(MAX_MARKS) }).strict();

export function emptyMarkupHistory(marks: ReviewMarkupMark[] = []): ReviewMarkupHistory {
  return { past: [], current: marks, future: [] };
}

export const markupMarkFitsMedia = reviewDrawingFitsMedia;

export function canAddMarkupMark(history: ReviewMarkupHistory): boolean {
  return history.current.length < MAX_MARKS;
}

function record(history: ReviewMarkupHistory, next: ReviewMarkupMark[]): ReviewMarkupHistory {
  if (sameMarks(history.current, next)) return history;
  return { past: [...history.past, history.current].slice(-MAX_HISTORY), current: next, future: [] };
}

function sameMarks(first: ReviewMarkupMark[], second: ReviewMarkupMark[]) {
  return first.length === second.length && first.every((mark, index) => mark === second[index]);
}

export function addMarkupMark(
  history: ReviewMarkupHistory,
  mark: ReviewMarkupMark,
  media: ImmutableMedia,
): ReviewMarkupHistory {
  if (!markSchema.safeParse(mark).success || !markupMarkFitsMedia(mark, media) || !canAddMarkupMark(history))
    return history;
  return record(history, [...history.current, mark]);
}

export function removeMarkupMark(history: ReviewMarkupHistory, id: string): ReviewMarkupHistory {
  return record(
    history,
    history.current.filter((mark) => mark.id !== id),
  );
}

export function undoMarkup(history: ReviewMarkupHistory): ReviewMarkupHistory {
  const previous = history.past.at(-1);
  return previous === undefined
    ? history
    : { past: history.past.slice(0, -1), current: previous, future: [history.current, ...history.future] };
}

export function redoMarkup(history: ReviewMarkupHistory): ReviewMarkupHistory {
  const next = history.future[0];
  return next === undefined
    ? history
    : { past: [...history.past, history.current], current: next, future: history.future.slice(1) };
}

type DraftState = { key: string; history: ReviewMarkupHistory; readable: boolean };

function readDraft(key: string, media: ImmutableMedia): DraftState {
  let stored: string | null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    return { key, history: emptyMarkupHistory(), readable: false };
  }
  if (stored === null) return { key, history: emptyMarkupHistory(), readable: true };
  try {
    const parsed = persistedDraftSchema.parse(JSON.parse(stored));
    if (!parsed.marks.every((mark) => markupMarkFitsMedia(mark, media)))
      throw new Error('draft does not fit this media');
    return { key, history: emptyMarkupHistory(parsed.marks), readable: true };
  } catch {
    return { key, history: emptyMarkupHistory(), readable: false };
  }
}

export function useReviewMarkupDraft(
  key: string,
  media: ImmutableMedia,
  confirmed: ReviewMarkupMark[] = NO_CONFIRMED_MARKS,
) {
  const [draft, setDraft] = useState<DraftState>(() => readDraft(key, media));
  const [storageError, setStorageError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isCurrentKey = draft.key === key;
  const canEdit = isCurrentKey && draft.readable;
  const marks = draft.history.current;
  useEffect(() => {
    if (isCurrentKey) return;
    setDraft(readDraft(key, media));
    setStorageError(false);
    setSelectedId(null);
  }, [isCurrentKey, key, media]);
  useEffect(() => {
    if (!canEdit || !confirmed.length) return;
    const committed = new Map(confirmed.map((mark) => [mark.id, JSON.stringify(markSchema.parse(mark))]));
    setDraft((current) => {
      if (current.key !== key || !current.readable) return current;
      const remaining = current.history.current.filter(
        (mark) => committed.get(mark.id) !== JSON.stringify(markSchema.parse(mark)),
      );
      return remaining.length === current.history.current.length
        ? current
        : { ...current, history: emptyMarkupHistory(remaining) };
    });
  }, [canEdit, key, confirmed]);
  useEffect(() => {
    if (!canEdit) return;
    try {
      localStorage.setItem(key, JSON.stringify({ v: 1, marks }));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [canEdit, key, marks]);
  useEffect(() => {
    if (selectedId && !marks.some((mark) => mark.id === selectedId)) setSelectedId(null);
  }, [marks, selectedId]);
  const update = (apply: (history: ReviewMarkupHistory) => ReviewMarkupHistory) =>
    setDraft((current) =>
      current.key === key && current.readable ? { ...current, history: apply(current.history) } : current,
    );
  return {
    marks,
    selectedId,
    storageError,
    readError: isCurrentKey && !draft.readable,
    canEdit,
    canAdd: canEdit && canAddMarkupMark(draft.history),
    canUndo: draft.history.past.length > 0,
    canRedo: draft.history.future.length > 0,
    add: (mark: ReviewMarkupMark) => update((current) => addMarkupMark(current, mark, media)),
    remove: (id: string) => update((current) => removeMarkupMark(current, id)),
    undo: () => update(undoMarkup),
    redo: () => update(redoMarkup),
    select: (id: string | null) => setSelectedId(id && marks.some((mark) => mark.id === id) ? id : null),
    clear: () => update((current) => record(current, [])),
    retry: () => {
      setDraft(readDraft(key, media));
      setStorageError(false);
      setSelectedId(null);
    },
  };
}
