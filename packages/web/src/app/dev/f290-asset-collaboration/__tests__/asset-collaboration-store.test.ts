import { describe, expect, it } from 'vitest';
import {
  createInitialAssetCollaborationState,
  parseAssetCollaborationState,
  persistAssetCollaborationState,
  reduceAssetCollaboration,
} from '../asset-collaboration-store';

describe('F290 asset collaboration browser-owned store', () => {
  it('ignores corrupt, incomplete, and dangling persisted payloads', () => {
    expect(parseAssetCollaborationState('{broken')).toBeNull();
    expect(parseAssetCollaborationState(JSON.stringify({ schemaVersion: 999 }))).toBeNull();

    const dangling = createInitialAssetCollaborationState();
    dangling.history.push({
      id: 'history-dangling',
      actor: 'You',
      action: 'annotated',
      summary: 'dangling',
      createdAt: '2026-08-25T00:00:00.000Z',
      target: { kind: 'annotation', annotationId: 'missing', sectionId: 'memory' },
    });
    expect(parseAssetCollaborationState(JSON.stringify(dangling))).toBeNull();

    const wrongUpdatedAt = JSON.stringify(createInitialAssetCollaborationState()).replace(
      /"updatedAt":"[^"]+"/,
      '"updatedAt":7',
    );
    expect(parseAssetCollaborationState(wrongUpdatedAt)).toBeNull();
  });

  it('migrates the prior v1 suggestion shape without dropping user state', () => {
    const sentinel = 'TERRA-REENTRY-LEGACY-V1-ANNOTATION';
    const state = reduceAssetCollaboration(createInitialAssetCollaborationState(), {
      type: 'add_annotation',
      sectionId: 'memory',
      id: 'legacy-v1-annotation',
      historyId: 'legacy-v1-history',
      body: sentinel,
      at: '2026-08-25T03:00:00.000Z',
    });
    const legacyRaw = JSON.stringify(state)
      .replace('"schemaVersion":2', '"schemaVersion":1')
      .replace(/,"baseVersionId":"[^"]+"/, '');

    const restored = parseAssetCollaborationState(legacyRaw);

    expect(restored?.schemaVersion).toBe(2);
    expect(restored?.suggestions[0]?.baseVersionId).toBe('version-3');
    expect(restored?.annotations.at(-1)?.body).toBe(sentinel);
    expect(restored?.history.at(-1)?.detail).toBe(sentinel);

    const unresolvableLegacyRaw = legacyRaw.replace('"reason":"fixture"', '"reason":"manual-edit"');
    expect(parseAssetCollaborationState(unresolvableLegacyRaw)).toBeNull();
  });

  it('rejects history and UI references whose IDs belong to another section', () => {
    const annotationMismatch = createInitialAssetCollaborationState();
    annotationMismatch.history.push({
      id: 'history-wrong-annotation-section',
      actor: 'You',
      action: 'annotated',
      summary: 'wrong annotation relation',
      createdAt: '2026-08-25T03:01:00.000Z',
      target: { kind: 'annotation', annotationId: 'fixture-annotation-2', sectionId: 'events' },
    });
    expect(parseAssetCollaborationState(JSON.stringify(annotationMismatch))).toBeNull();

    const suggestionMismatch = createInitialAssetCollaborationState();
    suggestionMismatch.history.push({
      id: 'history-wrong-suggestion-section',
      actor: 'You',
      action: 'proposed',
      summary: 'wrong suggestion relation',
      createdAt: '2026-08-25T03:02:00.000Z',
      target: { kind: 'suggestion', suggestionId: 'memory-boundary', sectionId: 'events' },
    });
    expect(parseAssetCollaborationState(JSON.stringify(suggestionMismatch))).toBeNull();

    const uiMismatch = createInitialAssetCollaborationState();
    uiMismatch.ui.selectedSectionId = 'events';
    uiMismatch.ui.activeAnnotationId = 'fixture-annotation-2';
    expect(parseAssetCollaborationState(JSON.stringify(uiMismatch))).toBeNull();
  });

  it('makes a suggestion decision terminal and idempotent', () => {
    const initial = createInitialAssetCollaborationState();
    const accepted = reduceAssetCollaboration(initial, {
      type: 'accept_suggestion',
      suggestionId: 'memory-boundary',
      versionId: 'version-4',
      historyId: 'history-accept',
      at: '2026-08-25T01:00:00.000Z',
    });
    const repeated = reduceAssetCollaboration(accepted, {
      type: 'accept_suggestion',
      suggestionId: 'memory-boundary',
      versionId: 'version-5',
      historyId: 'history-repeat',
      at: '2026-08-25T01:01:00.000Z',
    });

    expect(accepted.suggestions[0]?.status).toBe('accepted');
    expect(accepted.suggestions[0]?.decisionReason).toBe(initial.suggestions[0]?.reason);
    expect(accepted.versions.at(-1)?.sections.find((section) => section.id === 'memory')?.body).toContain(
      '关系记忆、长期偏好和互动历史由 Clowder AI 持有。',
    );
    expect(accepted.history.at(-1)?.detail).toBe(initial.suggestions[0]?.reason);
    expect(accepted.history).toHaveLength(initial.history.length + 1);
    expect(repeated).toBe(accepted);
    expect(repeated.history.filter((entry) => entry.id === 'history-accept')).toHaveLength(1);
    expect(repeated.history.some((entry) => entry.id === 'history-repeat')).toBe(false);
  });

  it('refuses a stale suggestion after a human saves a newer version', () => {
    const sentinel = 'TERRA-REVIEW-HUMAN-MEMORY-EDIT';
    let state = createInitialAssetCollaborationState();
    state = reduceAssetCollaboration(state, { type: 'start_edit' });
    const currentBody = state.ui.editDrafts.memory;
    state = reduceAssetCollaboration(state, {
      type: 'set_edit_draft',
      sectionId: 'memory',
      value: `${currentBody} ${sentinel}`,
    });
    state = reduceAssetCollaboration(state, {
      type: 'save_edit',
      versionId: 'version-4-human',
      historyId: 'history-human-edit',
      at: '2026-08-25T01:30:00.000Z',
    });

    const afterHumanEdit = state;
    const afterStaleAccept = reduceAssetCollaboration(state, {
      type: 'accept_suggestion',
      suggestionId: 'memory-boundary',
      versionId: 'version-5-stale',
      historyId: 'history-stale-accept',
      at: '2026-08-25T01:31:00.000Z',
    });

    expect(afterStaleAccept).toBe(afterHumanEdit);
    expect(afterStaleAccept.suggestions[0]?.status).toBe('pending');
    expect(afterStaleAccept.versions).toHaveLength(2);
    expect(afterStaleAccept.versions.at(-1)?.sections.find((section) => section.id === 'memory')?.body).toContain(
      sentinel,
    );
    expect(afterStaleAccept.history.some((entry) => entry.id === 'history-stale-accept')).toBe(false);
  });

  it('round-trips drafts, focus, and scroll continuity', () => {
    let state = createInitialAssetCollaborationState();
    state = reduceAssetCollaboration(state, { type: 'set_panel', panel: 'discussion' });
    state = reduceAssetCollaboration(state, { type: 'set_discussion_draft', value: 'SENTINEL-draft' });
    state = reduceAssetCollaboration(state, { type: 'set_scroll', surface: 'sidebar', value: 321 });

    const restored = parseAssetCollaborationState(JSON.stringify(state));
    expect(restored?.ui.panel).toBe('discussion');
    expect(restored?.ui.discussionDraft).toBe('SENTINEL-draft');
    expect(restored?.ui.scroll.sidebar).toBe(321);
  });

  it('reports storage failure without rejecting the in-memory transition', () => {
    const state = reduceAssetCollaboration(createInitialAssetCollaborationState(), {
      type: 'add_discussion',
      id: 'discussion-sentinel',
      historyId: 'history-sentinel',
      body: 'SENTINEL survives quota failure',
      at: '2026-08-25T02:00:00.000Z',
    });
    const storage = {
      setItem() {
        throw new Error('quota');
      },
    };

    expect(persistAssetCollaborationState(state, storage)).toBe(false);
    expect(state.discussions.at(-1)?.body).toBe('SENTINEL survives quota failure');
  });
});
