import type {
  Annotation,
  AssetCollaborationState,
  AssetSection,
  DiscussionMessage,
  HistoryAction,
  HistoryTarget,
} from './asset-collaboration-types';
import copy from './product-copy.json';

const SECTION_IDS = ['platform', 'memory', 'events'] as const;

function fixtureSections(): AssetSection[] {
  return copy.asset.sections.map((section, index) => ({
    id: SECTION_IDS[index] ?? `section-${index + 1}`,
    title: section.title,
    body: section.body,
  }));
}

function fixtureAnnotations(): Annotation[] {
  return copy.discussion.map((message, index) => ({
    id: `fixture-annotation-${index + 1}`,
    sectionId: SECTION_IDS[index] ?? SECTION_IDS[0],
    author: message.author,
    body: message.text,
    createdAt: `2026-07-${index + 12}T${index === 0 ? '15:47' : index === 1 ? '16:58' : '14:10'}:00.000Z`,
  }));
}

function fixtureDiscussions(): DiscussionMessage[] {
  return [
    {
      id: 'fixture-discussion-1',
      author: '吴浪',
      body: '这份约定先聚焦平台、记忆和事件三条边界，其他能力等真实需求出现再补。',
      createdAt: '2026-07-12T15:40:00.000Z',
    },
    {
      id: 'fixture-discussion-2',
      author: 'You',
      body: '可以，先把会影响用户关系和数据归属的边界写清楚。',
      createdAt: '2026-07-12T16:52:00.000Z',
    },
  ];
}

function recordAction(index: number): HistoryAction {
  return (
    ['proposed', 'reviewed', 'annotated', 'accepted', 'disagreed', 'versioned', 'reviewed', 'versioned'] as const
  )[index];
}

function recordTarget(index: number): HistoryTarget {
  if (index === 5 || index === 7) return { kind: 'version', versionId: 'version-3' };
  return { kind: 'section', sectionId: SECTION_IDS[index % SECTION_IDS.length] ?? SECTION_IDS[0] };
}

export function createAssetCollaborationFixture(): AssetCollaborationState {
  const sections = fixtureSections();
  return {
    schemaVersion: 2,
    currentIdentity: 'You',
    asset: {
      title: copy.asset.title,
      origin: copy.asset.origin,
      summary: copy.asset.summary,
      versionId: 'version-3',
      updatedAt: '2026-07-15T08:36:00.000Z',
    },
    versions: [
      {
        id: 'version-3',
        number: 3,
        sections,
        createdAt: '2026-07-15T08:36:00.000Z',
        reason: 'fixture',
      },
    ],
    annotations: fixtureAnnotations(),
    discussions: fixtureDiscussions(),
    suggestions: [
      {
        id: 'memory-boundary',
        sectionId: 'memory',
        baseVersionId: 'version-3',
        title: copy.change.title,
        reason: copy.change.reason,
        recommendation: copy.change.recommendation,
        beforeBody: copy.change.before,
        proposedBody: copy.change.after,
        status: 'pending',
      },
    ],
    history: copy.records.map((record, index) => ({
      id: record.id,
      actor: record.actor,
      action: recordAction(index),
      summary: record.title,
      detail: record.detail,
      sourceUrl: record.sourceUrl,
      createdAt: `2026-07-${String(index < 5 ? 12 + Math.floor(index / 4) : 13 + Math.floor((index - 5) / 2)).padStart(
        2,
        '0',
      )}T${String(9 + index).padStart(2, '0')}:00:00.000Z`,
      target: recordTarget(index),
    })),
    ui: {
      panel: 'annotations',
      selectedSectionId: 'memory',
      isEditing: false,
      annotationDrafts: {},
      discussionDraft: '',
      editDrafts: {},
      disagreementDraft: '',
      scroll: { document: 0, sidebar: 0 },
    },
  };
}
