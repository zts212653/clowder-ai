import { createAssetCollaborationFixture } from './asset-collaboration-fixture';
import type {
  AssetCollaborationAction,
  AssetCollaborationState,
  AssetSection,
  AssetVersion,
  HistoryEntry,
  Suggestion,
} from './asset-collaboration-types';

export {
  F290_ASSET_STORAGE_KEY,
  parseAssetCollaborationState,
  persistAssetCollaborationState,
  readAssetCollaborationState,
} from './asset-collaboration-persistence';
export * from './asset-collaboration-types';

function copySections(sections: AssetSection[]): AssetSection[] {
  return sections.map((section) => ({ ...section }));
}

export function createInitialAssetCollaborationState(): AssetCollaborationState {
  return createAssetCollaborationFixture();
}

export function selectCurrentVersion(state: AssetCollaborationState): AssetVersion {
  const version = state.versions.find((candidate) => candidate.id === state.asset.versionId);
  if (!version) throw new Error(`Missing current asset version: ${state.asset.versionId}`);
  return version;
}

export function selectVisibleVersion(state: AssetCollaborationState): AssetVersion {
  if (state.ui.viewingVersionId) {
    const version = state.versions.find((candidate) => candidate.id === state.ui.viewingVersionId);
    if (version) return version;
  }
  return selectCurrentVersion(state);
}

export function selectAnnotationCount(state: AssetCollaborationState, sectionId?: string): number {
  if (!sectionId) return state.annotations.length;
  return state.annotations.filter((annotation) => annotation.sectionId === sectionId).length;
}

export function selectPendingSuggestionCount(state: AssetCollaborationState): number {
  return state.suggestions.filter((suggestion) => suggestion.status === 'pending').length;
}

export type SuggestionAcceptBlock = 'editing' | 'stale';

export function selectSuggestionAcceptBlock(
  state: AssetCollaborationState,
  suggestion: Suggestion,
): SuggestionAcceptBlock | null {
  if (state.ui.isEditing) return 'editing';
  const current = selectCurrentVersion(state);
  const section = current.sections.find((candidate) => candidate.id === suggestion.sectionId);
  const sourceOccurrences = section?.body.split(suggestion.beforeBody).length ?? 0;
  if (current.id !== suggestion.baseVersionId || sourceOccurrences !== 2) return 'stale';
  return null;
}

function appendHistory(state: AssetCollaborationState, entry: HistoryEntry): HistoryEntry[] {
  return [...state.history, entry];
}

function withNewVersion(
  state: AssetCollaborationState,
  versionId: string,
  at: string,
  reason: AssetVersion['reason'],
  sections: AssetSection[],
): { asset: AssetCollaborationState['asset']; versions: AssetVersion[] } {
  const nextVersion: AssetVersion = {
    id: versionId,
    number: selectCurrentVersion(state).number + 1,
    sections: copySections(sections),
    createdAt: at,
    reason,
  };
  return {
    asset: { ...state.asset, versionId, updatedAt: at },
    versions: [...state.versions, nextVersion],
  };
}

function openHistoryTarget(state: AssetCollaborationState, historyId: string): AssetCollaborationState {
  const entry = state.history.find((candidate) => candidate.id === historyId);
  if (!entry) return state;
  const baseUi = { ...state.ui, selectedHistoryId: historyId, isEditing: false };

  switch (entry.target.kind) {
    case 'section':
      return {
        ...state,
        ui: {
          ...baseUi,
          panel: 'annotations',
          selectedSectionId: entry.target.sectionId,
          viewingVersionId: undefined,
        },
      };
    case 'annotation':
      return {
        ...state,
        ui: {
          ...baseUi,
          panel: 'annotations',
          selectedSectionId: entry.target.sectionId,
          activeAnnotationId: entry.target.annotationId,
          viewingVersionId: undefined,
        },
      };
    case 'discussion':
      return {
        ...state,
        ui: { ...baseUi, panel: 'discussion', activeDiscussionId: entry.target.messageId, viewingVersionId: undefined },
      };
    case 'version':
      return { ...state, ui: { ...baseUi, panel: 'history', viewingVersionId: entry.target.versionId } };
    case 'suggestion':
      return {
        ...state,
        ui: {
          ...baseUi,
          panel: 'history',
          selectedSectionId: entry.target.sectionId,
          viewingVersionId: undefined,
        },
      };
  }
}

export function reduceAssetCollaboration(
  state: AssetCollaborationState,
  action: AssetCollaborationAction,
): AssetCollaborationState {
  switch (action.type) {
    case 'set_panel':
      return { ...state, ui: { ...state.ui, panel: action.panel } };
    case 'select_section':
      if (!selectCurrentVersion(state).sections.some((section) => section.id === action.sectionId)) return state;
      return {
        ...state,
        ui: {
          ...state.ui,
          panel: 'annotations',
          selectedSectionId: action.sectionId,
          activeAnnotationId: undefined,
          viewingVersionId: undefined,
        },
      };
    case 'set_annotation_draft':
      return {
        ...state,
        ui: {
          ...state.ui,
          annotationDrafts: { ...state.ui.annotationDrafts, [action.sectionId]: action.value },
        },
      };
    case 'cancel_annotation':
      return {
        ...state,
        ui: { ...state.ui, annotationDrafts: { ...state.ui.annotationDrafts, [action.sectionId]: '' } },
      };
    case 'add_annotation': {
      const body = action.body.trim();
      const section = selectCurrentVersion(state).sections.find((candidate) => candidate.id === action.sectionId);
      if (!body || !section || state.annotations.some((annotation) => annotation.id === action.id)) return state;
      return {
        ...state,
        annotations: [
          ...state.annotations,
          { id: action.id, sectionId: action.sectionId, author: state.currentIdentity, body, createdAt: action.at },
        ],
        history: appendHistory(state, {
          id: action.historyId,
          actor: state.currentIdentity,
          action: 'annotated',
          summary: `批注“${section.title}”`,
          detail: body,
          createdAt: action.at,
          target: { kind: 'annotation', annotationId: action.id, sectionId: action.sectionId },
        }),
        ui: {
          ...state.ui,
          panel: 'annotations',
          activeAnnotationId: action.id,
          annotationDrafts: { ...state.ui.annotationDrafts, [action.sectionId]: '' },
        },
      };
    }
    case 'set_discussion_draft':
      return { ...state, ui: { ...state.ui, discussionDraft: action.value } };
    case 'add_discussion': {
      const body = action.body.trim();
      if (!body || state.discussions.some((message) => message.id === action.id)) return state;
      return {
        ...state,
        discussions: [
          ...state.discussions,
          { id: action.id, author: state.currentIdentity, body, createdAt: action.at },
        ],
        history: appendHistory(state, {
          id: action.historyId,
          actor: state.currentIdentity,
          action: 'discussed',
          summary: '参与整份产物讨论',
          detail: body,
          createdAt: action.at,
          target: { kind: 'discussion', messageId: action.id },
        }),
        ui: { ...state.ui, panel: 'discussion', activeDiscussionId: action.id, discussionDraft: '' },
      };
    }
    case 'start_edit':
      return {
        ...state,
        ui: {
          ...state.ui,
          isEditing: true,
          viewingVersionId: undefined,
          editDrafts: Object.fromEntries(
            selectCurrentVersion(state).sections.map((section) => [section.id, section.body]),
          ),
        },
      };
    case 'set_edit_draft':
      return {
        ...state,
        ui: { ...state.ui, editDrafts: { ...state.ui.editDrafts, [action.sectionId]: action.value } },
      };
    case 'cancel_edit':
      return { ...state, ui: { ...state.ui, isEditing: false, editDrafts: {} } };
    case 'save_edit': {
      const current = selectCurrentVersion(state);
      const sections = current.sections.map((section) => ({
        ...section,
        body: state.ui.editDrafts[section.id] ?? section.body,
      }));
      if (sections.some((section) => !section.body.trim())) return state;
      if (sections.every((section, index) => section.body === current.sections[index]?.body)) return state;
      const version = withNewVersion(state, action.versionId, action.at, 'manual-edit', sections);
      return {
        ...state,
        ...version,
        history: appendHistory(state, {
          id: action.historyId,
          actor: state.currentIdentity,
          action: 'edited',
          summary: `保存 v${selectCurrentVersion(state).number + 1}`,
          createdAt: action.at,
          target: { kind: 'version', versionId: action.versionId },
        }),
        ui: { ...state.ui, isEditing: false, editDrafts: {}, viewingVersionId: undefined },
      };
    }
    case 'set_disagreement_draft':
      return { ...state, ui: { ...state.ui, disagreementDraft: action.value } };
    case 'accept_suggestion': {
      const suggestion = state.suggestions.find((candidate) => candidate.id === action.suggestionId);
      if (!suggestion || suggestion.status !== 'pending') return state;
      if (selectSuggestionAcceptBlock(state, suggestion)) return state;
      const sections = selectCurrentVersion(state).sections.map((section) =>
        section.id === suggestion.sectionId
          ? { ...section, body: section.body.replace(suggestion.beforeBody, suggestion.proposedBody) }
          : { ...section },
      );
      const version = withNewVersion(state, action.versionId, action.at, 'accepted-suggestion', sections);
      return {
        ...state,
        ...version,
        suggestions: state.suggestions.map((candidate) =>
          candidate.id === suggestion.id
            ? { ...candidate, status: 'accepted', decidedAt: action.at, decisionReason: suggestion.reason }
            : candidate,
        ),
        history: appendHistory(state, {
          id: action.historyId,
          actor: state.currentIdentity,
          action: 'accepted',
          summary: '已接受修改建议',
          detail: suggestion.reason,
          createdAt: action.at,
          target: { kind: 'suggestion', suggestionId: suggestion.id, sectionId: suggestion.sectionId },
        }),
        ui: { ...state.ui, viewingVersionId: undefined },
      };
    }
    case 'disagree_suggestion': {
      const reason = action.reason.trim();
      const suggestion = state.suggestions.find((candidate) => candidate.id === action.suggestionId);
      if (!reason || !suggestion || suggestion.status !== 'pending') return state;
      return {
        ...state,
        suggestions: state.suggestions.map((candidate) =>
          candidate.id === suggestion.id
            ? { ...candidate, status: 'disagreed', decidedAt: action.at, decisionReason: reason }
            : candidate,
        ),
        history: appendHistory(state, {
          id: action.historyId,
          actor: state.currentIdentity,
          action: 'disagreed',
          summary: '已保留分歧',
          detail: reason,
          createdAt: action.at,
          target: { kind: 'suggestion', suggestionId: suggestion.id, sectionId: suggestion.sectionId },
        }),
        ui: { ...state.ui, disagreementDraft: '' },
      };
    }
    case 'open_history_target':
      return openHistoryTarget(state, action.historyId);
    case 'return_to_current_version':
      return { ...state, ui: { ...state.ui, viewingVersionId: undefined } };
    case 'set_scroll':
      if (!Number.isFinite(action.value) || action.value < 0) return state;
      return { ...state, ui: { ...state.ui, scroll: { ...state.ui.scroll, [action.surface]: action.value } } };
  }
}
