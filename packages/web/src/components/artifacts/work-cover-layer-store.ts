import type { ThreadArtifactDTO, WorkCoverChoice, WorkCoverView, WorkReference } from '@cat-cafe/shared';
import { create } from 'zustand';
import type { WorkCoverSaved } from './work-cover-client';

// Card menus only reach this small store; the picker itself is mounted once by the page-level layer, so a
// work card never pulls the picker's conversation and upload readers into its own import graph.

/** The notice only controls how long the undo offer is shown; the saved choice itself never expires. */
export const UNDO_NOTICE_MS = 8000;

type Undo = { reference: WorkReference; choice: WorkCoverChoice; expected: number; operationId: string };
type Notice = { id: number; text: string; undo?: Undo };
/** Where focus returns: the same card position (found again after its list re-renders) or the opener. */
type CardSpot = { id: string; index: number };
export type FocusReturn = CardSpot | HTMLElement;
type Picker = {
  artifact: ThreadArtifactDTO;
  title: string;
  metadata?: string;
  view: WorkCoverView;
  focus: FocusReturn | null;
};

let noticeId = 0;
export const useWorkCoverLayer = create<{
  picker: Picker | null;
  notice: Notice | null;
  openPicker(picker: Picker): void;
  closePicker(): void;
  showNotice(text: string, undo?: Undo): void;
  hideNotice(): void;
}>((set) => ({
  picker: null,
  notice: null,
  openPicker: (picker) => set({ picker }),
  closePicker: () => set({ picker: null }),
  showNotice: (text, undo) => set({ notice: { id: ++noticeId, text, undo } }),
  hideNotice: () => set({ notice: null }),
}));

const cardButtons = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('.work-gallery-open[data-home-artifact-id]')].filter(
    (node) => node.dataset.homeArtifactId === id,
  );

export function workCardSpot(card: HTMLElement | null): CardSpot | null {
  const button = card?.querySelector<HTMLElement>('.work-gallery-open[data-home-artifact-id]');
  const id = button?.dataset.homeArtifactId;
  return button && id ? { id, index: Math.max(0, cardButtons(id).indexOf(button)) } : null;
}

/** Return focus to the card, and again if its list replaces the card while a change notice refreshes it. */
export function returnFocus(target: FocusReturn | null) {
  if (!target) return;
  if (target instanceof HTMLElement) {
    if (target.isConnected) target.focus({ preventScroll: true });
    return;
  }
  returnFocusToCard(target);
}

function returnFocusToCard(spot: CardSpot) {
  const focus = () => {
    const target = cardButtons(spot.id)[spot.index] ?? cardButtons(spot.id)[0];
    target?.focus({ preventScroll: true });
    return target;
  };
  let current = focus();
  const watch = new MutationObserver(() => {
    if (current?.isConnected && document.activeElement === current) return;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== current) {
      watch.disconnect();
      return;
    }
    current = focus();
  });
  watch.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => watch.disconnect(), 4000);
}

export function undoChoice(previous: WorkCoverView): WorkCoverChoice {
  return previous.coverRevision > 0 ? { mode: 'restore', coverRevision: previous.coverRevision } : { mode: 'frame' };
}

export function noticeAfterSave(
  reference: WorkReference,
  saved: WorkCoverSaved,
  previous: WorkCoverView,
  text: string,
) {
  useWorkCoverLayer.getState().showNotice(text, {
    reference,
    choice: undoChoice(previous),
    expected: saved.record.coverRevision,
    operationId: crypto.randomUUID(),
  });
}
