export type AssetPanel = 'annotations' | 'discussion' | 'history';
export type SuggestionStatus = 'pending' | 'accepted' | 'disagreed';
export type HistoryAction =
  | 'proposed'
  | 'reviewed'
  | 'annotated'
  | 'discussed'
  | 'edited'
  | 'accepted'
  | 'disagreed'
  | 'versioned';

export interface AssetSection {
  id: string;
  title: string;
  body: string;
}

export interface AssetVersion {
  id: string;
  number: number;
  sections: AssetSection[];
  createdAt: string;
  reason: 'fixture' | 'manual-edit' | 'accepted-suggestion';
}

export interface Annotation {
  id: string;
  sectionId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface DiscussionMessage {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface Suggestion {
  id: string;
  sectionId: string;
  baseVersionId: string;
  title: string;
  reason: string;
  recommendation: string;
  beforeBody: string;
  proposedBody: string;
  status: SuggestionStatus;
  decidedAt?: string;
  decisionReason?: string;
}

export type HistoryTarget =
  | { kind: 'section'; sectionId: string }
  | { kind: 'annotation'; annotationId: string; sectionId: string }
  | { kind: 'discussion'; messageId: string }
  | { kind: 'version'; versionId: string }
  | { kind: 'suggestion'; suggestionId: string; sectionId: string };

export interface HistoryEntry {
  id: string;
  actor: string;
  action: HistoryAction;
  summary: string;
  detail?: string;
  sourceUrl?: string;
  createdAt: string;
  target: HistoryTarget;
}

export interface AssetUiContinuity {
  panel: AssetPanel;
  selectedSectionId: string;
  activeAnnotationId?: string;
  activeDiscussionId?: string;
  selectedHistoryId?: string;
  viewingVersionId?: string;
  isEditing: boolean;
  annotationDrafts: Record<string, string>;
  discussionDraft: string;
  editDrafts: Record<string, string>;
  disagreementDraft: string;
  scroll: { document: number; sidebar: number };
}

export interface AssetCollaborationState {
  schemaVersion: 2;
  currentIdentity: 'You';
  asset: {
    title: string;
    origin: string;
    summary: string;
    versionId: string;
    updatedAt: string;
  };
  versions: AssetVersion[];
  annotations: Annotation[];
  discussions: DiscussionMessage[];
  suggestions: Suggestion[];
  history: HistoryEntry[];
  ui: AssetUiContinuity;
}

export type AssetCollaborationAction =
  | { type: 'set_panel'; panel: AssetPanel }
  | { type: 'select_section'; sectionId: string }
  | { type: 'set_annotation_draft'; sectionId: string; value: string }
  | { type: 'cancel_annotation'; sectionId: string }
  | { type: 'add_annotation'; sectionId: string; id: string; historyId: string; body: string; at: string }
  | { type: 'set_discussion_draft'; value: string }
  | { type: 'add_discussion'; id: string; historyId: string; body: string; at: string }
  | { type: 'start_edit' }
  | { type: 'set_edit_draft'; sectionId: string; value: string }
  | { type: 'cancel_edit' }
  | { type: 'save_edit'; versionId: string; historyId: string; at: string }
  | { type: 'set_disagreement_draft'; value: string }
  | { type: 'accept_suggestion'; suggestionId: string; versionId: string; historyId: string; at: string }
  | { type: 'disagree_suggestion'; suggestionId: string; historyId: string; reason: string; at: string }
  | { type: 'open_history_target'; historyId: string }
  | { type: 'return_to_current_version' }
  | { type: 'set_scroll'; surface: 'document' | 'sidebar'; value: number };
