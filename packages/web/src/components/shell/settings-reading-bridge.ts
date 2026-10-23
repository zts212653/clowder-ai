import type { SettingsReturnDiagnostic } from '@cat-cafe/shared';
import { readChatReadingRef, releaseChatReadingRef } from '@/utils/chat-scroll-memory';
import { connectionDiagnosticId, recordConnectionDiagnostic } from '@/utils/connection-diagnostics';
import { verifyMessageNavigationSource } from '../message-search/verify-message-navigation-source';
import { getThreadHref, getThreadIdFromPathname } from '../ThreadSidebar/thread-navigation';
import type { ChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import { getSettingsReadingScope } from './settings-reading-scope';
import {
  clearSettingsReadingSession,
  markSettingsReadingReturnAttempted,
  readSettingsReadingSession,
  type SettingsReadingSession,
  settingsReadingReturnAttempted,
  startSettingsReadingSession,
} from './settings-reading-session';

export type SettingsReturnNotice = 'not-saved' | 'unavailable' | 'interrupted' | 'clear-failed' | 'save-failed' | null;
export interface SettingsReadingView {
  source: SettingsReadingSession | null;
  persisted: boolean;
  returning: boolean;
  notice: SettingsReturnNotice;
}
interface PendingReturn {
  sessionId: string;
  controller: AbortController;
  admitted: boolean;
  port: ChatReadingPort | null;
}
export function isSettingsRoute(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/');
}
function chatThread(pathname: string): string | null {
  return pathname === '/' || pathname.startsWith('/thread/') ? getThreadIdFromPathname(pathname) : null;
}

/** Shell navigation association; the registered chat port remains the only reader. */
export class SettingsReadingBridge {
  private diagnosticId = connectionDiagnosticId();
  private noticeSequence = 0;
  private view: SettingsReadingView = { source: null, persisted: true, returning: false, notice: null };
  private listeners = new Set<() => void>();
  private pathname = '';
  private enabled = false;
  private initialized = false;
  private disposed = false;
  private associationStored = false;
  private attempted = false;
  private reader: { port: ChatReadingPort; label: () => string | null } | null = null;
  private pending: PendingReturn | null = null;

  constructor(
    private push: (path: string) => void,
    private scope = getSettingsReadingScope(),
    private restorable = true,
  ) {
    this.diagnose('created');
  }
  private diagnose(
    phase: SettingsReturnDiagnostic['phase'],
    cause?: SettingsReturnDiagnostic['cause'],
    notice = this.view.notice,
  ): void {
    recordConnectionDiagnostic({
      kind: 'settings_return',
      bridgeId: this.diagnosticId,
      phase,
      cause,
      notice,
      noticeSeq: this.noticeSequence,
      returning: this.view.returning,
      hasSource: this.view.source !== null,
      hasReader: this.reader !== null,
      admitted: this.pending?.admitted ?? false,
    });
  }
  noticePresented(notice: Exclude<SettingsReturnNotice, null>): void {
    this.diagnose('presented', undefined, notice);
  }
  getSnapshot = (): SettingsReadingView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** A presented notice is consumed by its owner, independent of consumer mounts. */
  consumeNotice(expectedView: SettingsReadingView): SettingsReturnNotice {
    const notice = this.view.notice;
    if (!notice || this.view !== expectedView) return null;
    this.diagnose('consumed');
    this.publish({ notice: null });
    return notice;
  }
  private publish(patch: Partial<SettingsReadingView>, cause?: SettingsReturnDiagnostic['cause']): void {
    this.view = { ...this.view, ...patch };
    if (patch.notice) {
      this.noticeSequence += 1;
      this.diagnose('notice', cause);
    }
    for (const listener of this.listeners) listener();
  }
  private cancel(notice: SettingsReturnNotice, cause: SettingsReturnDiagnostic['cause']): void {
    const operation = this.pending;
    if (operation) this.diagnose('cancel', cause, notice);
    this.pending = null;
    operation?.controller.abort();
    if (operation) this.publish({ returning: false, notice }, cause);
  }
  private retireSource(): void {
    const source = this.view.source;
    if (!source) return;
    const retired = this.associationStored
      ? clearSettingsReadingSession(source.id, this.scope)
      : { cleared: true, referenceReleased: releaseChatReadingRef(source.readingRef, source.threadId) };
    this.publish(
      {
        source: retired.cleared ? null : source,
        notice: retired.cleared && retired.referenceReleased ? null : 'clear-failed',
      },
      'retire',
    );
  }
  setRoute(pathname: string, enabled: boolean): void {
    this.disposed = false;
    if (!this.initialized && enabled) {
      this.initialized = true;
      this.storageChanged();
      if (!isSettingsRoute(pathname) && this.view.source && !this.attempted) this.retireSource();
    }
    const source = this.view.source;
    if (source && isSettingsRoute(this.pathname) && !isSettingsRoute(pathname) && !this.attempted) {
      this.retireSource();
    }
    if (
      !enabled ||
      (this.pending &&
        pathname !== this.pathname &&
        !(this.pending.admitted && chatThread(pathname) === source?.threadId))
    )
      this.cancel(null, 'route');
    if (!enabled || pathname !== this.pathname) this.reader = null;
    this.pathname = pathname;
    this.enabled = enabled;
  }
  registerReadingPort(port: ChatReadingPort, label: () => string | null): () => void {
    if (!this.enabled || chatThread(this.pathname) !== port.threadId) return () => {};
    if (this.pending?.port && this.pending.port !== port) this.cancel('interrupted', 'reader_replaced');
    const registration = { port, label };
    this.reader = registration;
    if (this.pending) void this.drive(this.pending, port);
    return () => {
      if (this.reader !== registration) return;
      this.reader = null;
      if (this.pending?.port === port) this.cancel('interrupted', 'reader_unregistered');
    };
  }
  captureBeforeSettings(): void {
    this.diagnose('capture');
    const reader = this.reader;
    const label = reader?.label();
    if (!this.enabled || !chatThread(this.pathname)) return;
    if (!reader || chatThread(this.pathname) !== reader.port.threadId || !label?.trim()) {
      this.cancel(null, 'capture');
      this.retireSource();
      return;
    }
    this.cancel(null, 'capture');
    const point = reader.port.captureReadingRef();
    if (!point || readChatReadingRef(point.ref)?.threadId !== reader.port.threadId) {
      this.retireSource();
      this.publish({ notice: 'unavailable' }, 'capture');
      return;
    }
    const origin = { threadId: reader.port.threadId, label, readingRef: point.ref };
    const started = point.persisted
      ? startSettingsReadingSession(origin, this.scope)
      : {
          session: { id: crypto.randomUUID(), ...origin },
          persisted: false,
        };
    this.associationStored = started.persisted;
    this.attempted = false;
    this.publish(
      {
        source: started.session,
        persisted: started.persisted && this.restorable,
        returning: false,
        notice: started.persisted && this.restorable ? null : 'not-saved',
      },
      'capture',
    );
  }
  private current(operation: PendingReturn): boolean {
    const source = this.view.source;
    if (
      this.disposed ||
      this.pending !== operation ||
      operation.controller.signal.aborted ||
      source?.id !== operation.sessionId
    )
      return false;
    if (!this.associationStored) return true;
    const active = readSettingsReadingSession(this.scope);
    if (active?.id === source.id && active.readingRef === source.readingRef && active.threadId === source.threadId)
      return true;
    this.storageChanged();
    return false;
  }
  async returnToSource(expectedId: string): Promise<void> {
    const source = this.view.source;
    if (!this.enabled || this.disposed || !source || source.id !== expectedId || this.pending) return;
    if (this.associationStored && !markSettingsReadingReturnAttempted(source.id, this.scope)) {
      this.publish({ notice: 'save-failed' }, 'return_mark');
      return;
    }
    this.attempted = true;
    const operation: PendingReturn = {
      sessionId: source.id,
      controller: new AbortController(),
      admitted: false,
      port: null,
    };
    this.pending = operation;
    this.publish({ returning: true, notice: null });
    this.diagnose('return');
    const admission = await verifyMessageNavigationSource({ threadId: source.threadId }, operation.controller.signal);
    if (!this.current(operation)) return;
    if (admission.status !== 'available') {
      this.cancel('unavailable', 'admission');
      return;
    }
    operation.admitted = true;
    this.push(
      source.threadId === 'default' ? getThreadHref('default') : `/thread/${encodeURIComponent(source.threadId)}`,
    );
    if (this.reader) void this.drive(operation, this.reader.port);
  }
  private async drive(operation: PendingReturn, port: ChatReadingPort): Promise<void> {
    const source = this.view.source;
    if (
      !source ||
      !this.current(operation) ||
      !operation.admitted ||
      operation.port ||
      port.threadId !== source.threadId ||
      chatThread(this.pathname) !== source.threadId
    )
      return;
    operation.port = port;
    let receipt: Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>;
    try {
      receipt = await port.restoreReadingRef(source.readingRef, operation.controller.signal, { refresh: true });
    } catch {
      receipt = { status: 'unavailable' };
    }
    if (!this.current(operation) || this.reader?.port !== port) return;
    if (receipt.status !== 'settled' || !receipt.exact) {
      this.cancel(receipt.status === 'interrupted' ? 'interrupted' : 'unavailable', 'restore');
      return;
    }
    this.pending = null;
    const consumed = this.associationStored
      ? clearSettingsReadingSession(source.id, this.scope)
      : {
          cleared: true,
          referenceReleased: releaseChatReadingRef(source.readingRef, source.threadId),
        };
    this.publish({
      source: consumed.cleared ? null : source,
      returning: false,
      notice: consumed.cleared && consumed.referenceReleased ? null : 'clear-failed',
    });
  }
  storageChanged(): void {
    const source = readSettingsReadingSession(this.scope);
    if (source?.id === this.view.source?.id && source?.readingRef === this.view.source?.readingRef) return;
    this.cancel('interrupted', 'storage');
    this.associationStored = source !== null;
    this.attempted = source ? settingsReadingReturnAttempted(source.id, this.scope) : false;
    this.publish({ source, persisted: true, returning: false, notice: null });
  }
  dispose(): void {
    this.diagnose('disposed');
    this.disposed = true;
    this.cancel(null, 'dispose');
    this.reader = null;
    this.listeners.clear();
  }
}
