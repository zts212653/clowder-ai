import type {
  Annotation,
  AssetCollaborationState,
  AssetSection,
  AssetUiContinuity,
  AssetVersion,
  DiscussionMessage,
  HistoryEntry,
  HistoryTarget,
  Suggestion,
} from './asset-collaboration-types';

export const F290_ASSET_STORAGE_KEY = 'cat-cafe:f290-asset-collaboration:v1';

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function hasUniqueIds(values: Array<{ id: string }>): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}

function deriveLegacySuggestionBaseVersionId(suggestion: Record<string, unknown>, versions: unknown[]): string | null {
  if (!isNonEmptyString(suggestion.sectionId) || !isNonEmptyString(suggestion.beforeBody)) return null;
  const candidates = versions.filter((version) => {
    if (!isRecord(version) || version.reason !== 'fixture' || !isNonEmptyString(version.id)) return false;
    if (!Array.isArray(version.sections)) return false;
    return version.sections.some(
      (section) =>
        isRecord(section) &&
        section.id === suggestion.sectionId &&
        typeof section.body === 'string' &&
        section.body.split(suggestion.beforeBody as string).length === 2,
    );
  });
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  return isRecord(candidate) && isNonEmptyString(candidate.id) ? candidate.id : null;
}

function migrateLegacyV1(value: unknown): unknown | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return value;
  if (!Array.isArray(value.versions) || !Array.isArray(value.suggestions)) return null;

  const suggestions: Record<string, unknown>[] = [];
  for (const suggestion of value.suggestions) {
    if (!isRecord(suggestion)) return null;
    if (isNonEmptyString(suggestion.baseVersionId)) {
      suggestions.push({ ...suggestion });
      continue;
    }
    const baseVersionId = deriveLegacySuggestionBaseVersionId(suggestion, value.versions);
    if (!baseVersionId) return null;
    suggestions.push({ ...suggestion, baseVersionId });
  }

  return { ...value, schemaVersion: 2, suggestions };
}

function isSection(value: unknown): value is AssetSection {
  return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.title) && isNonEmptyString(value.body);
}

function isVersion(value: unknown): value is AssetVersion {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    typeof value.number !== 'number' ||
    !Number.isInteger(value.number) ||
    value.number < 1
  )
    return false;
  if (
    !isTimestamp(value.createdAt) ||
    !['fixture', 'manual-edit', 'accepted-suggestion'].includes(String(value.reason))
  )
    return false;
  return Array.isArray(value.sections) && value.sections.length > 0 && value.sections.every(isSection);
}

function isAnnotation(value: unknown): value is Annotation {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.sectionId) &&
    isNonEmptyString(value.author) &&
    isNonEmptyString(value.body) &&
    isTimestamp(value.createdAt)
  );
}

function isDiscussion(value: unknown): value is DiscussionMessage {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.author) &&
    isNonEmptyString(value.body) &&
    isTimestamp(value.createdAt)
  );
}

function isSuggestion(value: unknown): value is Suggestion {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.sectionId) ||
    !isNonEmptyString(value.baseVersionId) ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.reason) ||
    !isNonEmptyString(value.recommendation) ||
    !isNonEmptyString(value.beforeBody) ||
    !isNonEmptyString(value.proposedBody)
  ) {
    return false;
  }
  if (!['pending', 'accepted', 'disagreed'].includes(String(value.status))) return false;
  if (!isOptionalString(value.decidedAt) || !isOptionalString(value.decisionReason)) return false;
  if (value.status === 'pending') {
    return value.decidedAt === undefined && value.decisionReason === undefined;
  }
  return isTimestamp(value.decidedAt) && isNonEmptyString(value.decisionReason);
}

function isHistoryTarget(value: unknown): value is HistoryTarget {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'section':
      return isNonEmptyString(value.sectionId);
    case 'annotation':
      return isNonEmptyString(value.annotationId) && isNonEmptyString(value.sectionId);
    case 'discussion':
      return isNonEmptyString(value.messageId);
    case 'version':
      return isNonEmptyString(value.versionId);
    case 'suggestion':
      return isNonEmptyString(value.suggestionId) && isNonEmptyString(value.sectionId);
    default:
      return false;
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.actor) &&
    ['proposed', 'reviewed', 'annotated', 'discussed', 'edited', 'accepted', 'disagreed', 'versioned'].includes(
      String(value.action),
    ) &&
    isNonEmptyString(value.summary) &&
    isOptionalString(value.detail) &&
    isOptionalString(value.sourceUrl) &&
    isTimestamp(value.createdAt) &&
    isHistoryTarget(value.target)
  );
}

function isUiContinuity(value: unknown): value is AssetUiContinuity {
  if (!isRecord(value) || !['annotations', 'discussion', 'history'].includes(String(value.panel))) return false;
  if (!isNonEmptyString(value.selectedSectionId) || typeof value.isEditing !== 'boolean') return false;
  if (!isStringRecord(value.annotationDrafts) || !isStringRecord(value.editDrafts)) return false;
  if (typeof value.discussionDraft !== 'string' || typeof value.disagreementDraft !== 'string') return false;
  if (
    !isOptionalString(value.activeAnnotationId) ||
    !isOptionalString(value.activeDiscussionId) ||
    !isOptionalString(value.selectedHistoryId) ||
    !isOptionalString(value.viewingVersionId)
  ) {
    return false;
  }
  return (
    isRecord(value.scroll) &&
    typeof value.scroll.document === 'number' &&
    Number.isFinite(value.scroll.document) &&
    value.scroll.document >= 0 &&
    typeof value.scroll.sidebar === 'number' &&
    Number.isFinite(value.scroll.sidebar) &&
    value.scroll.sidebar >= 0
  );
}

function targetResolves(state: AssetCollaborationState, target: HistoryTarget): boolean {
  const sections = state.versions.flatMap((version) => version.sections);
  switch (target.kind) {
    case 'section':
      return sections.some((section) => section.id === target.sectionId);
    case 'annotation':
      return state.annotations.some(
        (annotation) => annotation.id === target.annotationId && annotation.sectionId === target.sectionId,
      );
    case 'discussion':
      return state.discussions.some((message) => message.id === target.messageId);
    case 'version':
      return state.versions.some((version) => version.id === target.versionId);
    case 'suggestion':
      return state.suggestions.some(
        (suggestion) => suggestion.id === target.suggestionId && suggestion.sectionId === target.sectionId,
      );
  }
}

function isAsset(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.origin) &&
    isNonEmptyString(value.summary) &&
    isNonEmptyString(value.versionId) &&
    isTimestamp(value.updatedAt)
  );
}

function hasValidCollections(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.versions) &&
    value.versions.every(isVersion) &&
    Array.isArray(value.annotations) &&
    value.annotations.every(isAnnotation) &&
    Array.isArray(value.discussions) &&
    value.discussions.every(isDiscussion) &&
    Array.isArray(value.suggestions) &&
    value.suggestions.every(isSuggestion) &&
    Array.isArray(value.history) &&
    value.history.every(isHistoryEntry) &&
    isUiContinuity(value.ui)
  );
}

function hasUniqueEntityIds(state: AssetCollaborationState): boolean {
  return (
    hasUniqueIds(state.versions) &&
    hasUniqueIds(state.annotations) &&
    hasUniqueIds(state.discussions) &&
    hasUniqueIds(state.suggestions) &&
    hasUniqueIds(state.history) &&
    state.versions.every((version) => hasUniqueIds(version.sections))
  );
}

function suggestionsResolve(state: AssetCollaborationState): boolean {
  return state.suggestions.every((suggestion) => {
    const base = state.versions.find((version) => version.id === suggestion.baseVersionId);
    const section = base?.sections.find((candidate) => candidate.id === suggestion.sectionId);
    return Boolean(section && section.body.split(suggestion.beforeBody).length === 2);
  });
}

function uiResolves(state: AssetCollaborationState, current: AssetVersion): boolean {
  const currentSectionIds = new Set(current.sections.map((section) => section.id));
  if (!currentSectionIds.has(state.ui.selectedSectionId)) return false;
  if (state.ui.viewingVersionId && !state.versions.some((version) => version.id === state.ui.viewingVersionId))
    return false;
  if (state.annotations.some((annotation) => !currentSectionIds.has(annotation.sectionId))) return false;
  if (Object.keys(state.ui.annotationDrafts).some((sectionId) => !currentSectionIds.has(sectionId))) return false;
  if (Object.keys(state.ui.editDrafts).some((sectionId) => !currentSectionIds.has(sectionId))) return false;
  if (
    state.ui.activeAnnotationId &&
    !state.annotations.some(
      (entry) => entry.id === state.ui.activeAnnotationId && entry.sectionId === state.ui.selectedSectionId,
    )
  )
    return false;
  if (state.ui.activeDiscussionId && !state.discussions.some((entry) => entry.id === state.ui.activeDiscussionId))
    return false;
  return !state.ui.selectedHistoryId || state.history.some((entry) => entry.id === state.ui.selectedHistoryId);
}

function isValidState(value: unknown): value is AssetCollaborationState {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.currentIdentity !== 'You') return false;
  if (!isAsset(value.asset) || !hasValidCollections(value)) return false;

  const state = value as unknown as AssetCollaborationState;
  if (!hasUniqueEntityIds(state)) return false;
  const current = state.versions.find((version) => version.id === state.asset.versionId);
  if (!current || state.asset.updatedAt !== current.createdAt) return false;
  return (
    suggestionsResolve(state) &&
    uiResolves(state, current) &&
    state.history.every((entry) => targetResolves(state, entry.target))
  );
}

export function parseAssetCollaborationState(raw: string | null): AssetCollaborationState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrateLegacyV1(parsed);
    return migrated && isValidState(migrated) ? migrated : null;
  } catch {
    return null;
  }
}

export function readAssetCollaborationState(
  storage: StorageReader,
  key = F290_ASSET_STORAGE_KEY,
): AssetCollaborationState | null {
  try {
    return parseAssetCollaborationState(storage.getItem(key));
  } catch {
    return null;
  }
}

export function persistAssetCollaborationState(
  state: AssetCollaborationState,
  storage: StorageWriter,
  key = F290_ASSET_STORAGE_KEY,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
