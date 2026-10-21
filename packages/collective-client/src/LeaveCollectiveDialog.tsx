import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { CollectiveClientRequestError } from './client-request.js';
import { LeaveResponsibilityGroups } from './LeaveResponsibilityGroups.js';
import type {
  LeaveReadinessArtifact,
  LeaveReadinessProject,
  LeaveReadinessWork,
  MembershipLeaveReadiness,
} from './leave-readiness.js';

export interface LeaveCollectiveDialogProps {
  readonly collectiveName: string;
  readonly read: () => Promise<MembershipLeaveReadiness>;
  readonly leave: () => Promise<void>;
  readonly onClose: () => void;
  readonly onOpenWork: (work: LeaveReadinessWork) => void;
  readonly onOpenProject: (project: LeaveReadinessProject) => void;
  readonly onOpenArtifact: (artifact: Extract<LeaveReadinessArtifact, { kind: 'artifact' }>) => void;
  readonly onOpenMembers: () => void;
}

type DialogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read-failed' }
  | { readonly kind: 'ready'; readonly readiness: MembershipLeaveReadiness }
  | { readonly kind: 'leaving'; readonly readiness: MembershipLeaveReadiness }
  | { readonly kind: 'leave-failed'; readonly readiness: MembershipLeaveReadiness; readonly message: string };

export function LeaveCollectiveDialog(props: LeaveCollectiveDialogProps) {
  const [state, setState] = useState<DialogState>({ kind: 'loading' });
  const generation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const busy = state.kind === 'leaving';

  const check = useCallback(async () => {
    const current = ++generation.current;
    setState({ kind: 'loading' });
    try {
      const readiness = await props.read();
      if (current === generation.current) setState({ kind: 'ready', readiness });
    } catch {
      if (current === generation.current) setState({ kind: 'read-failed' });
    }
  }, [props.read]);

  useEffect(() => {
    void check();
    return () => {
      ++generation.current;
    };
  }, [check]);

  useEffect(() => closeButton.current?.focus(), []);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [busy, props.onClose]);

  const attemptLeave = async (readiness: MembershipLeaveReadiness) => {
    if (!readiness.canLeave || readiness.role !== 'member') return;
    setState({ kind: 'leaving', readiness });
    try {
      await props.leave();
      props.onClose();
    } catch (error) {
      if (error instanceof CollectiveClientRequestError && error.status === 409) {
        await check();
        return;
      }
      setState({ kind: 'leave-failed', readiness, message: leaveFailureMessage(error) });
    }
  };

  const readiness = 'readiness' in state ? state.readiness : undefined;
  const readyToLeave = Boolean(readiness && readinessIsCompleteAndEmpty(readiness));
  const close = () => {
    if (!busy) props.onClose();
  };
  const leaveFor =
    <Value,>(callback: (value: Value) => void) =>
    (value: Value) => {
      callback(value);
      props.onClose();
    };
  const trapFocus = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea'),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="leave-dialog-layer">
      <button
        type="button"
        className="leave-dialog-backdrop"
        aria-label="关闭离开共同体对话框"
        disabled={busy}
        onClick={close}
      />
      <dialog
        ref={dialog}
        open
        className="leave-dialog"
        aria-labelledby="leave-dialog-title"
        aria-busy={busy || undefined}
        onKeyDown={trapFocus}
      >
        <header className="leave-dialog-header">
          <h2 id="leave-dialog-title">{leaveDialogTitle(props.collectiveName)}</h2>
          <button ref={closeButton} type="button" aria-label="关闭离开共同体对话框" disabled={busy} onClick={close}>
            ×
          </button>
        </header>
        <div className="leave-dialog-body" aria-live="polite">
          {state.kind === 'loading' && <p className="leave-dialog-state">正在看还有哪些事没处理…</p>}
          {state.kind === 'read-failed' && (
            <div className="leave-dialog-state" role="alert">
              <strong>没能检查还有哪些事没处理</strong>
              <p>没有完整结果时不会把清单当成空。请重新检查。</p>
            </div>
          )}
          {readiness && !readyToLeave && (
            <>
              <p>下面这些处理完才能离开。点一件，回到它原来的地方。</p>
              <LeaveResponsibilityGroups
                readiness={readiness}
                onOpenWork={leaveFor(props.onOpenWork)}
                onOpenProject={leaveFor(props.onOpenProject)}
                onOpenArtifact={leaveFor(props.onOpenArtifact)}
                onOpenMembers={() => {
                  props.onOpenMembers();
                  props.onClose();
                }}
              />
            </>
          )}
          {readiness && readyToLeave && <p>离开以后，你的 Café 马上停止在这里读取和发送；公开历史和署名会保留。</p>}
          {state.kind === 'leave-failed' && (
            <div className="leave-dialog-error" role="alert">
              <strong>没能离开</strong>
              <span>{state.message}</span>
            </div>
          )}
        </div>
        <DialogFooter
          state={state}
          readyToLeave={readyToLeave}
          onClose={close}
          onCheck={() => void check()}
          onLeave={() => readiness && void attemptLeave(readiness)}
        />
      </dialog>
    </div>
  );
}

function DialogFooter({
  state,
  readyToLeave,
  onClose,
  onCheck,
  onLeave,
}: {
  readonly state: DialogState;
  readonly readyToLeave: boolean;
  readonly onClose: () => void;
  readonly onCheck: () => void;
  readonly onLeave: () => void;
}) {
  if (state.kind === 'loading') {
    return (
      <footer className="leave-dialog-footer">
        <button type="button" onClick={onClose}>
          取消
        </button>
      </footer>
    );
  }
  if (state.kind === 'read-failed') {
    return (
      <footer className="leave-dialog-footer">
        <button type="button" onClick={onCheck}>
          重试
        </button>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </footer>
    );
  }
  if (!readyToLeave) {
    return (
      <footer className="leave-dialog-footer leave-dialog-footer-split">
        <small>处理完回来点「重新检查」</small>
        <span>
          <button type="button" onClick={onCheck}>
            重新检查
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </span>
      </footer>
    );
  }
  const leaving = state.kind === 'leaving';
  return (
    <footer className="leave-dialog-footer">
      <button type="button" disabled={leaving} onClick={onClose}>
        取消
      </button>
      <button type="button" className="leave-dialog-danger" disabled={leaving} onClick={onLeave}>
        {leaving ? '正在离开…' : state.kind === 'leave-failed' ? '重试' : '离开共同体'}
      </button>
    </footer>
  );
}

function leaveFailureMessage(error: unknown): string {
  if (error instanceof CollectiveClientRequestError) {
    if (error.status === 401) return '登录状态已经失效，请重新登录后再试。';
    if (error.status === 403) return '你现在没有离开这个共同体的权限。';
    if (error.status >= 500) return '共同体服务暂时不可用，请稍后重试。';
  }
  return '暂时没能离开，请重试。';
}

function leaveDialogTitle(collectiveName: string): string {
  return /^[A-Za-z0-9]/u.test(collectiveName) ? `离开 ${collectiveName}` : `离开${collectiveName}`;
}

function readinessIsCompleteAndEmpty(readiness: MembershipLeaveReadiness): boolean {
  return (
    readiness.role === 'member' &&
    readiness.canLeave &&
    !readiness.governanceHandoffRequired &&
    readiness.responsibilities.works.length === 0 &&
    readiness.responsibilities.roadmaps.length === 0 &&
    readiness.responsibilities.artifacts.items.length === 0 &&
    readiness.responsibilities.artifacts.inaccessibleCount === 0
  );
}
