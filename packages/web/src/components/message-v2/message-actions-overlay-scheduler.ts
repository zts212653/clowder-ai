import { readActionPort } from './message-actions-overlay-geometry';

export interface ActionPlaneContext {
  epoch: number;
  column: DOMRect;
  port: { top: number; bottom: number; left: number; right: number };
  compact: boolean;
  touch: boolean;
}
export interface ActionPlaneEntry {
  row: HTMLElement;
  node: HTMLElement;
  width: number;
  authorLine: HTMLElement | null;
  suspend(): void;
  retire(): void;
  measure(context: ActionPlaneContext): () => void;
}

const COMPACT = '(max-width: 767px), (hover: none) and (pointer: coarse)';
const TOUCH = '(hover: none) and (pointer: coarse)';
const columns = new WeakMap<HTMLElement, ActionPlaneScheduler>();
const epochs = new WeakMap<HTMLElement, number>();

export function hideActionPlane(node: HTMLElement) {
  node.style.visibility = 'hidden';
  node.setAttribute('inert', '');
  node.setAttribute('aria-hidden', 'true');
  node.dataset.messageActionsReady = 'false';
  delete node.dataset.messageActionsCommittedEpoch;
  const active = document.activeElement;
  if (active instanceof HTMLElement && node.contains(active)) active.blur();
}

/** One observer/listener cohort per reading column; only intersecting owners force layout. */
class ActionPlaneScheduler {
  private entries = new Map<HTMLElement, ActionPlaneEntry>();
  private visible = new Set<HTMLElement>();
  private frame: number | null = null;
  private disposed = false;
  private epoch = 0;
  private viewport = window.innerWidth;
  private port: HTMLElement | null;
  private media = typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT) : null;
  private coarse = typeof window.matchMedia === 'function' ? window.matchMedia(TOUCH) : null;
  private intersection: IntersectionObserver | null;
  private resize: ResizeObserver | null;
  private mutations: MutationObserver;
  private authors: MutationObserver;

  constructor(private column: HTMLElement) {
    this.epoch = epochs.get(column) ?? 0;
    column.dataset.messageActionsEpoch = String(this.epoch);
    this.port = column.closest('[data-chat-container]');
    this.resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.beginInvalidation();
            const bounds = this.column.getBoundingClientRect();
            for (const entry of this.entries.values()) this.pin(entry, bounds);
            this.schedule();
          });
    this.resize?.observe(column);
    if (this.port) this.resize?.observe(this.port);
    this.intersection =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (records) => {
              for (const record of records) {
                const row = record.target as HTMLElement;
                const entry = this.entries.get(row);
                if (!entry) continue;
                if (record.isIntersecting) {
                  this.visible.add(row);
                  this.resize?.observe(row);
                  this.resize?.observe(entry.node);
                } else {
                  this.visible.delete(row);
                  this.resize?.unobserve(row);
                  this.resize?.unobserve(entry.node);
                  entry.retire();
                }
              }
              this.watchAuthors();
              this.schedule();
            },
            { root: this.port },
          );
    // The shared subtree watch covers row-local ownership; ancestor watches are installed once.
    this.mutations = new MutationObserver((records) => {
      // Managed surfaces are outputs of this scheduler, not another ownership input.
      if (
        records.every(
          (record) => record.target instanceof Element && record.target.closest('[data-message-action-owned]'),
        )
      )
        return;
      this.beginInvalidation();
      const bounds = this.column.getBoundingClientRect();
      for (const entry of this.entries.values()) this.pin(entry, bounds);
      if (this.intersection) this.schedule();
      else this.flush();
    });
    this.authors = new MutationObserver(() => {
      this.beginInvalidation();
      this.schedule();
    });
    for (let parent: HTMLElement | null = column; parent; parent = parent.parentElement) {
      this.mutations.observe(parent, {
        attributes: true,
        subtree: parent === column,
        attributeFilter: ['aria-hidden', 'inert', 'hidden', 'class', 'style'],
      });
    }
    window.addEventListener('scroll', this.invalidate, true);
    window.addEventListener('resize', this.invalidate);
    this.media?.addEventListener('change', this.invalidate);
    this.coarse?.addEventListener('change', this.invalidate);
  }

  private hideVisible() {
    for (const row of this.visible) {
      const entry = this.entries.get(row);
      if (entry) entry.suspend();
    }
  }

  private beginInvalidation() {
    this.column.dataset.messageActionsEpoch = String(++this.epoch);
    epochs.set(this.column, this.epoch);
    this.hideVisible();
  }

  private watchAuthors() {
    this.authors.disconnect();
    for (const row of this.visible) {
      const line = this.entries.get(row)?.authorLine;
      if (line)
        this.authors.observe(line, {
          subtree: true,
          characterData: true,
          childList: true,
          attributes: true,
          attributeFilter: ['title'],
        });
    }
  }

  refresh() {
    this.beginInvalidation();
    this.schedule();
  }

  private pin(entry: ActionPlaneEntry, bounds: DOMRect) {
    const previous = Number.parseFloat(entry.node.style.left);
    entry.node.style.left = `${Math.max(
      bounds.left,
      Math.min(Number.isFinite(previous) ? previous : bounds.left, bounds.right - entry.width),
    )}px`;
    entry.node.dataset.messageActionsViewport = String(window.innerWidth);
    entry.node.dataset.messageActionsColumnWidth = String(bounds.width);
  }

  private invalidate = (event?: Event) => {
    const target = event?.target;
    // Scrolling a derived body portal does not move the reading column or its author slots.
    if (
      event?.type === 'scroll' &&
      target instanceof Element &&
      !target.contains(this.column) &&
      !this.column.contains(target)
    )
      return;
    // Hide before the next paint; a focused/coarse control cannot survive its owner's clip.
    this.beginInvalidation();
    if (this.viewport !== window.innerWidth) {
      this.viewport = window.innerWidth;
      const bounds = this.column.getBoundingClientRect();
      // Cached portal widths keep hidden nodes horizontally contained without reading offscreen rows.
      for (const entry of this.entries.values()) this.pin(entry, bounds);
    }
    this.schedule();
  };

  private schedule = () => {
    if (this.frame !== null || this.disposed) return;
    this.frame = window.requestAnimationFrame(this.flush);
  };

  private flush = () => {
    this.frame = null;
    if (this.disposed) return;
    const context: ActionPlaneContext = {
      epoch: this.epoch,
      column: this.column.getBoundingClientRect(),
      port: readActionPort(this.port),
      compact: Boolean(this.media?.matches),
      touch: Boolean(this.coarse?.matches),
    };
    const writes: (() => void)[] = [];
    for (const row of this.visible) {
      const entry = this.entries.get(row);
      if (entry) writes.push(entry.measure(context));
    }
    // All visible reads finish before any positioning/style writes.
    for (const write of writes) write();
  };

  add(entry: ActionPlaneEntry) {
    this.entries.set(entry.row, entry);
    entry.suspend();
    this.pin(entry, this.column.getBoundingClientRect());
    if (this.intersection) this.intersection.observe(entry.row);
    else {
      this.visible.add(entry.row);
      this.watchAuthors();
      this.flush();
    }
    return () => {
      this.intersection?.unobserve(entry.row);
      this.resize?.unobserve(entry.row);
      this.resize?.unobserve(entry.node);
      this.entries.delete(entry.row);
      this.visible.delete(entry.row);
      this.watchAuthors();
      if (this.entries.size) return;
      this.disposed = true;
      if (this.frame !== null) window.cancelAnimationFrame(this.frame);
      this.intersection?.disconnect();
      this.resize?.disconnect();
      this.mutations.disconnect();
      this.authors.disconnect();
      window.removeEventListener('scroll', this.invalidate, true);
      window.removeEventListener('resize', this.invalidate);
      this.media?.removeEventListener('change', this.invalidate);
      this.coarse?.removeEventListener('change', this.invalidate);
      columns.delete(this.column);
    };
  }
}

export function registerActionPlane(column: HTMLElement, entry: ActionPlaneEntry) {
  let scheduler = columns.get(column);
  if (!scheduler) {
    scheduler = new ActionPlaneScheduler(column);
    columns.set(column, scheduler);
  }
  return scheduler.add(entry);
}

export function refreshActionPlane(column: HTMLElement) {
  columns.get(column)?.refresh();
}
