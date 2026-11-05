/** Fixed diagnostic vocabulary only: never pass configuration values, URLs, names or error messages. */
export type SavePhase =
  | 'save'
  | 'onboarding.entry'
  | 'member.write'
  | 'strategy.write'
  | 'codex.write'
  | 'refresh'
  | 'ui.commit'
  | 'session.wait'
  | 'session.refresh'
  | 'http.attempt';
type State = 'start' | 'finish' | 'failed' | 'slow' | 'aborted';
interface Timing {
  seq: number;
  phase: SavePhase;
  state: State;
  elapsedMs: number;
  durationMs?: number;
  clientRequestId?: string;
  attempt?: number;
  statusCode?: number;
  errorKind?: 'timeout' | 'aborted' | 'network' | 'other';
}
type Emit = (
  phase: SavePhase,
  state: State,
  durationMs?: number,
  detail?: Pick<Timing, 'clientRequestId' | 'attempt' | 'statusCode' | 'errorKind'>,
) => void;
const active = new Map<string, Emit>();
const HEADER = 'x-clowder-save-id';
const REQUEST = 'x-clowder-save-request';
const STORAGE = 'member-save-diagnostics:v1';
const rounded = (ms: number) => Math.round(Math.max(0, ms) * 100) / 100;
function errorKind(error: unknown): Timing['errorKind'] {
  return error instanceof Error
    ? error.name === 'TimeoutError'
      ? 'timeout'
      : error.name === 'AbortError'
        ? 'aborted'
        : error.name === 'TypeError'
          ? 'network'
          : 'other'
    : 'other';
}

function diagnosticId(): string {
  // randomUUID is unavailable on HTTP LAN origins; diagnostics must still allow saving.
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (digit) => {
    const value = Number(digit);
    return (value ^ ((Math.random() * 16) >> (value / 4))).toString(16).slice(-1);
  });
}

export function tagSaveRequest(init?: RequestInit): RequestInit | undefined {
  const headers = new Headers(init?.headers);
  if (!active.has(headers.get(HEADER) ?? '')) return init;
  headers.set(REQUEST, diagnosticId());
  return { ...init, headers };
}

/** Called by apiFetch for explicitly tagged requests, including each physical 401 retry. */
export async function traceSaveTransport<T>(
  init: RequestInit | undefined,
  phase: SavePhase,
  operation: () => Promise<T>,
  attempt?: number,
): Promise<T> {
  const headers = new Headers(init?.headers);
  const emit = active.get(headers.get(HEADER) ?? '');
  if (!emit) return operation();
  const started = performance.now();
  const detail = { clientRequestId: headers.get(REQUEST) ?? undefined, attempt };
  emit(phase, 'start', undefined, detail);
  try {
    const result = await operation();
    emit(phase, result instanceof Response && !result.ok ? 'failed' : 'finish', performance.now() - started, {
      ...detail,
      ...(result instanceof Response ? { statusCode: result.status } : {}),
    });
    return result;
  } catch (error) {
    emit(phase, 'failed', performance.now() - started, { ...detail, errorKind: errorKind(error) });
    throw error;
  }
}

export function beginMemberSave(apiUrl: string, send?: (path: string, init: RequestInit) => Promise<Response>) {
  const traceId = diagnosticId();
  const started = performance.now();
  const events: Timing[] = [];
  let pending: Timing[] = [],
    timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0,
    finished = false,
    failed = false;
  function persist() {
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]');
      const previous = Array.isArray(raw) ? raw.filter((item) => item?.traceId !== traceId).slice(-9) : [];
      sessionStorage.setItem(STORAGE, JSON.stringify([...previous, { traceId, events }]));
    } catch {
      /* Private browsing/storage quota must not break a save. */
    }
  }
  function flush() {
    timer = undefined;
    if (!pending.length) return;
    const batch = pending.splice(0, 120);
    // Separate best-effort request; never await delivery on the save path or recurse through apiFetch.
    try {
      const init: RequestInit = {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traceId, events: batch }),
        signal: AbortSignal.timeout(2000),
      };
      const delivery = send
        ? send('/api/diagnostics/member-save', init)
        : fetch(`${apiUrl}/api/diagnostics/member-save`, init);
      void delivery.then(
        (response) => {
          if (!response.ok) pending = [...batch, ...pending].slice(-120);
        },
        () => {
          pending = [...batch, ...pending].slice(-120);
        },
      );
    } catch {
      pending = [...batch, ...pending].slice(-120);
    }
  }
  const emit: Emit = (phase, state, durationMs, detail = {}) => {
    if (seq >= 1024) return;
    const event: Timing = {
      seq: seq++,
      phase,
      state,
      elapsedMs: rounded(performance.now() - started),
      ...(durationMs === undefined ? {} : { durationMs: rounded(durationMs) }),
      ...detail,
    };
    events.push(event);
    if (events.length > 120) events.shift();
    pending.push(event);
    if (pending.length > 120) pending.shift();
    persist();
    if (phase === 'save') {
      try {
        console.info('[member-save]', traceId, JSON.stringify(event));
      } catch {}
    }
    timer ??= setTimeout(flush, 250);
  };
  if (active.size >= 32) active.delete(active.keys().next().value!);
  active.set(traceId, emit);
  emit('save', 'start');
  const slow = setInterval(() => emit('save', 'slow', performance.now() - started), 2000);
  const unload = () => {
    flush();
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', unload);
  return {
    traceId,
    headers() {
      return { [HEADER]: traceId, [REQUEST]: diagnosticId() };
    },
    async phase<T>(name: SavePhase, operation: () => Promise<T>): Promise<T> {
      const start = performance.now();
      emit(name, 'start');
      try {
        const value = await operation();
        emit(name, 'finish', performance.now() - start);
        return value;
      } catch (error) {
        failed = true;
        emit(name, 'failed', performance.now() - start, { errorKind: errorKind(error) });
        throw error;
      }
    },
    fail() {
      failed = true;
    },
    finish() {
      if (finished) return;
      finished = true;
      emit('save', failed ? 'failed' : 'finish', performance.now() - started);
      clearInterval(slow);
      active.delete(traceId);
      window.removeEventListener('pagehide', unload);
      if (timer !== undefined) clearTimeout(timer);
      flush();
    },
    committed() {
      emit('ui.commit', 'finish', performance.now() - started);
    },
  };
}
export type MemberSaveTrace = ReturnType<typeof beginMemberSave>;
