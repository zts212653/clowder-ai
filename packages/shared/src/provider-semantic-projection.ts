import {
  isProviderSemanticEvent,
  type ProviderSemanticEvent,
  type ProviderSemanticEventKind,
} from './types/provider-semantic-event.js';

export type ProviderSemanticSurface = 'timeline' | 'workspace' | 'entity';
export type ProviderSemanticMessageMode = 'replace' | 'augment' | 'suppress';

type ProviderSemanticProjectionDetails =
  | {
      surface: 'timeline';
      messageMode: ProviderSemanticMessageMode;
      content: string;
      severity: 'info' | 'warning' | 'error';
    }
  | {
      surface: 'workspace';
      messageMode: 'augment' | 'suppress';
      content: string;
      severity: 'info' | 'warning' | 'error';
    }
  | {
      surface: 'entity';
      messageMode: 'suppress';
      content: string;
      severity: 'info' | 'warning' | 'error';
    };

export type ProviderSemanticProjection =
  | ({
      status: 'projected';
      eventId: string;
      kind: ProviderSemanticEventKind;
    } & ProviderSemanticProjectionDetails)
  | { status: 'hidden_invalid'; reason: 'invalid_event' | 'unregistered_kind' | 'projector_error' };

type EventByKind<K extends ProviderSemanticEventKind> = Extract<ProviderSemanticEvent, { kind: K }>;
type Projector<K extends ProviderSemanticEventKind> = (event: EventByKind<K>) => ProviderSemanticProjectionDetails;
type ProjectorRegistry = { [K in ProviderSemanticEventKind]: Projector<K> };
export type ProviderSemanticProjectorOverrides = Partial<ProjectorRegistry>;

function timelineProjection(
  messageMode: ProviderSemanticMessageMode,
  content: string,
  severity: 'info' | 'warning' | 'error' = 'info',
): ProviderSemanticProjectionDetails {
  return { surface: 'timeline', messageMode, content, severity };
}

function workspaceProjection(
  messageMode: 'augment' | 'suppress',
  content: string,
  severity: 'info' | 'warning' | 'error' = 'info',
): ProviderSemanticProjectionDetails {
  return { surface: 'workspace', messageMode, content, severity };
}

function entityProjection(
  content: string,
  severity: 'info' | 'warning' | 'error' = 'info',
): ProviderSemanticProjectionDetails {
  return { surface: 'entity', messageMode: 'suppress', content, severity };
}

const NATIVE_REVIEW_DISCLAIMER = '这不是非作者独立 merge-gate review，不能作为合入批准。';

const registry = {
  plan: (event) => timelineProjection('replace', event.text),
  diff: (event) => workspaceProjection('augment', event.summary),
  reasoning: (event) => workspaceProjection('suppress', event.summary),
  warning: (event) =>
    timelineProjection(
      'replace',
      event.severity === 'warning' ? `警告：${event.message}` : event.message,
      event.severity,
    ),
  guardian: (event) => workspaceProjection('suppress', event.summary, event.outcome === 'fail' ? 'error' : 'info'),
  capability: (event) => entityProjection(`${event.capability}：${event.availability}`),
  goal: (event) => entityProjection(event.state === 'cleared' ? '当前目标已清除' : `当前目标：${event.objective}`),
  review: (event) =>
    workspaceProjection(
      'suppress',
      `Codex 原生 Review · ${event.summary}\n\n${NATIVE_REVIEW_DISCLAIMER}`,
      event.stage === 'failed' ? 'error' : (event.severity ?? 'info'),
    ),
} satisfies ProjectorRegistry;

export function projectProviderSemanticEvent(
  candidate: unknown,
  overrides: ProviderSemanticProjectorOverrides = {},
): ProviderSemanticProjection {
  if (!isProviderSemanticEvent(candidate)) return { status: 'hidden_invalid', reason: 'invalid_event' };
  const projector = (overrides[candidate.kind] ?? registry[candidate.kind]) as (
    event: ProviderSemanticEvent,
  ) => ProviderSemanticProjectionDetails;
  if (!projector) return { status: 'hidden_invalid', reason: 'unregistered_kind' };
  try {
    return { status: 'projected', eventId: candidate.id, kind: candidate.kind, ...projector(candidate) };
  } catch {
    return { status: 'hidden_invalid', reason: 'projector_error' };
  }
}

export type ProviderSemanticMessageResolution =
  | {
      action: 'replace' | 'augment';
      projection: Extract<ProviderSemanticProjection, { status: 'projected' }>;
    }
  | { action: 'suppress'; reason: 'invalid_event' | 'non_message_surface' | 'explicit_suppress' };

/** One carrier policy shared by live, background, hydration, socket, callback, and replay consumers. */
export function resolveProviderSemanticMessage(
  candidate: unknown,
  overrides: ProviderSemanticProjectorOverrides = {},
): ProviderSemanticMessageResolution {
  const projected = projectProviderSemanticEvent(candidate, overrides);
  if (projected.status !== 'projected') return { action: 'suppress', reason: 'invalid_event' };
  if (projected.messageMode === 'suppress') {
    return {
      action: 'suppress',
      reason: projected.surface === 'timeline' ? 'explicit_suppress' : 'non_message_surface',
    };
  }
  return { action: projected.messageMode, projection: projected };
}
