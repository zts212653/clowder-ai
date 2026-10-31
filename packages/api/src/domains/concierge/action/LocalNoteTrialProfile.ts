import type { CdpPageActionSpec } from './CdpPageBrowserTask.js';
import type { LivePageActionSelector } from './LivePageAction.js';
import type { PageActionResult, PageSnapshot } from './PageActionLoop.js';

export const LOCAL_NOTE_TRIAL_VALUE = 'F317 local trial';

export const localNoteTrialSpec: CdpPageActionSpec = Object.freeze({
  targets: Object.freeze([Object.freeze({ id: 'note', selector: '#note-input', operation: 'fill' as const })]),
  readback: Object.freeze({ selector: '#readback', kind: 'text' }),
});

interface LocalNoteState {
  readonly open: false;
  readonly note: string;
  readonly deleted: false;
}

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

function canonicalState(raw: string): LocalNoteState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Local note state unavailable');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Local note state unavailable');
  const state = parsed as Record<string, unknown>;
  if (
    Object.keys(state).join(',') !== 'open,note,deleted' ||
    state.open !== false ||
    typeof state.note !== 'string' ||
    state.deleted !== false ||
    JSON.stringify(state) !== raw
  )
    throw new Error('Local note state unavailable');
  return { open: false, note: state.note, deleted: false };
}

function localFixtureUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Expected an exact local fixture URL');
  }
  if (
    url.href !== value ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.port === '3001' ||
    url.port === '3002' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Expected an exact local fixture URL');
  return url;
}

function noteTarget(snapshot: PageSnapshot): PageSnapshot['candidates'][number] {
  const target = snapshot.candidates[0];
  if (
    snapshot.candidates.length !== 1 ||
    !target ||
    target.id !== 'note' ||
    target.operation !== 'fill' ||
    target.label !== 'Note text' ||
    !FINGERPRINT.test(target.fingerprint)
  )
    throw new Error('Local note target unavailable');
  return target;
}

/** Trusted only for a Host-launched instance of the checked-in disposable fixture. */
export function createLocalNoteTrialProfile(trustedUrl: string) {
  const url = localFixtureUrl(trustedUrl);
  return Object.freeze({
    profileId: 'f317-local-note' as const,
    url: trustedUrl,
    origin: url.origin,
    spec: localNoteTrialSpec,
    targetId: 'note' as const,
    label: 'Note text' as const,
    expectedReadback(value: string): string {
      if (value !== LOCAL_NOTE_TRIAL_VALUE && value !== '') throw new Error('Local note trial value unavailable');
      return JSON.stringify({ open: false, note: value, deleted: false });
    },
    originalValue(readback: string): string {
      const state = canonicalState(readback);
      if (state.note !== '') throw new Error('Local note state is not disposable');
      return state.note;
    },
  });
}

export interface LocalNoteAction {
  readonly targetId: 'note';
  readonly operation: 'fill';
  readonly value: string;
  readonly fingerprint: string;
  readonly expectedReadback: string;
}

export interface LocalNoteTrialPlan {
  readonly profileId: 'f317-local-note';
  readonly url: string;
  readonly origin: string;
  readonly beforeReadback: string;
  readonly action: LocalNoteAction;
  readonly consent: {
    readonly pageUrl: string;
    readonly field: 'Note text';
    readonly value: string;
    readonly restoreValue: string;
  };
}

export function prepareLocalNoteTrial(trustedUrl: string, snapshot: PageSnapshot): LocalNoteTrialPlan {
  const profile = createLocalNoteTrialProfile(trustedUrl);
  if (snapshot.url !== profile.url || snapshot.origin !== profile.origin)
    throw new Error('Local note resource changed');
  const restoreValue = profile.originalValue(snapshot.readback);
  const target = noteTarget(snapshot);
  return Object.freeze({
    profileId: profile.profileId,
    url: profile.url,
    origin: profile.origin,
    beforeReadback: snapshot.readback,
    action: Object.freeze({
      targetId: profile.targetId,
      operation: 'fill' as const,
      value: LOCAL_NOTE_TRIAL_VALUE,
      fingerprint: target.fingerprint,
      expectedReadback: profile.expectedReadback(LOCAL_NOTE_TRIAL_VALUE),
    }),
    consent: Object.freeze({
      pageUrl: profile.url,
      field: profile.label,
      value: LOCAL_NOTE_TRIAL_VALUE,
      restoreValue,
    }),
  });
}

export function prepareLocalNoteRollback(
  trial: LocalNoteTrialPlan,
  forwardResult: PageActionResult,
  snapshot: PageSnapshot,
): LocalNoteAction {
  if (
    forwardResult.status !== 'applied' ||
    forwardResult.before !== trial.beforeReadback ||
    forwardResult.after !== trial.action.expectedReadback
  )
    throw new Error('Local note forward effect unconfirmed');
  if (snapshot.url !== trial.url || snapshot.origin !== trial.origin) throw new Error('Local note resource changed');
  if (snapshot.readback !== forwardResult.after) throw new Error('Local note state changed before rollback');
  const target = noteTarget(snapshot);
  if (target.fingerprint === trial.action.fingerprint) throw new Error('Local note rollback needs a fresh target');
  return Object.freeze({
    targetId: 'note',
    operation: 'fill',
    value: trial.consent.restoreValue,
    fingerprint: target.fingerprint,
    expectedReadback: trial.beforeReadback,
  });
}

/** The first trial follows the owner's explicit field choice; page quotes do not select actions. */
export function selectLocalNoteAction(action: LocalNoteAction): LivePageActionSelector {
  if (
    action.targetId !== 'note' ||
    action.operation !== 'fill' ||
    !FINGERPRINT.test(action.fingerprint) ||
    (action.value !== LOCAL_NOTE_TRIAL_VALUE && action.value !== '') ||
    action.expectedReadback !== JSON.stringify({ open: false, note: action.value, deleted: false })
  )
    throw new Error('Local note trial action unavailable');
  return {
    async select({ candidates, signal }) {
      if (signal.aborted) return { kind: 'none', reason: 'stopped' };
      const target = candidates[0];
      if (
        candidates.length !== 1 ||
        !target ||
        target.id !== action.targetId ||
        target.operation !== action.operation ||
        target.fingerprint !== action.fingerprint
      )
        return { kind: 'ask', reason: 'target_unavailable' };
      return { kind: 'act', targetId: action.targetId, operation: action.operation, value: action.value };
    },
  };
}
