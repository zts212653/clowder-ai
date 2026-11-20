// @vitest-environment node
import { runInContext } from 'node:vm';
import { videoProjectDocumentSchema } from '@cat-cafe/shared';
import { expect, it, vi } from 'vitest';
import { initial } from '@/components/content-review/__tests__/review-command.fixture';
import { artifactRoundRequestSource } from '@/components/content-review/artifact-modification-source';
import { item, record } from '@/components/workbench/content-review/__tests__/asset-canon.fixtures';
import { digest, project } from '../../../../shared/src/__tests__/video-project.fixtures';
import { fixtureData, fixtureUi } from './chat-fixture';
import { createOwnerConsole, fixtureWorkbenchSource, fixtureWorkspace } from './owner-console';

function consoleSource(sources: Record<string, unknown>, state: Record<string, unknown> = {}) {
  const models = vi.fn(() => {
    throw new Error('A held projection must never pull models');
  });
  const render = vi.fn();
  const data = fixtureData();
  data.threadId = 'source-thread';
  const runtime = createOwnerConsole({
    data,
    sources,
    ui: { ...fixtureUi(), ...state },
    ws: {
      ...fixtureWorkspace(),
      film: { layout: 'list', tab: 'story', assets: {}, compare: '', opinion: null },
      canon: { reason: 'Owner draft', target: '', bindingChoices: {} },
    },
  });
  Object.assign(runtime.context, { __models: models, chatModels: models, binding: { models }, render });
  runInContext('chatPort = { models: __models };', runtime.context);
  const push = (next: Record<string, unknown>) => {
    runtime.context.__incoming = next;
    return runtime.read('pushProjectData(__incoming)');
  };
  return { ...runtime, models, render, push };
}

function expectOwnerPush(
  runtime: ReturnType<typeof consoleSource>,
  owner: string,
  source: unknown,
  changed: unknown,
  list: string,
  id: string,
  projection: string,
  title: string,
) {
  const ownerPath = `projectData('${owner}')`;
  const snapshot = runtime.read(ownerPath);
  const stable = runtime.read(`${ownerPath}.${list}[0]`);
  const previous = runtime.read(`${ownerPath}.${list}[1]`);
  const unchanged = { [owner]: { added: [], changed: [], removed: [], orderChanged: false, fields: [] } };
  expect(snapshot).not.toBe(source);
  expect(runtime.push({ [owner]: source })).toEqual(unchanged);
  expect(runtime.read(ownerPath)).toBe(snapshot);
  expect(runtime.render).not.toHaveBeenCalled();
  expect(runtime.push({ [owner]: changed })).toEqual({
    [owner]: {
      added: [],
      changed: [id],
      removed: [],
      orderChanged: false,
      fields: [],
    },
  });
  expect(runtime.read(`${ownerPath}.${list}[0]`)).toBe(stable);
  expect(runtime.read(`${ownerPath}.${list}[1]`)).not.toBe(previous);
  // A push names the sources it changed: only the containers that read them redraw.
  expect(runtime.render).toHaveBeenCalledExactlyOnceWith(true);
  const updated = runtime.read(ownerPath);
  expect(runtime.push({ [owner]: changed })).toEqual(unchanged);
  expect(runtime.read(ownerPath)).toBe(updated);
  for (let i = 0; i < 30; i++) expect(runtime.read(projection)).toBe(title);
  expect(runtime.render).toHaveBeenCalledTimes(1);
  expect(runtime.models).not.toHaveBeenCalled();
}

it('projects canon records and local draft choices without reading a host model or mutating held records', () => {
  const sources = {
    canon: {
      reference: record.reference,
      load: '',
      context: record,
      page: {
        items: [item, { ...item, record: { ...item.record, indexedVersionRef: 'canon-sibling', name: 'Sibling' } }],
        updates: [],
        snapshot: 'owner-snapshot',
      },
      detail: item,
      history: { history: [] },
    },
  };
  const before = JSON.stringify(sources);
  const runtime = consoleSource(sources);
  for (let i = 0; i < 30; i++) {
    expect(runtime.read('canonModels().assetCanon.detail.title')).toBe(item.record.name);
    expect(runtime.read('canonModels().assetCanon.detail.reasonDraft')).toBe('Owner draft');
  }
  expect(JSON.stringify(sources)).toBe(before);
  let next = { ...sources.canon };
  next = {
    ...next,
    page: {
      ...next.page,
      items: next.page.items.map((entry, index) =>
        index === 1
          ? { ...next.page.items[1], record: { ...next.page.items[1].record, name: 'Changed canon sibling' } }
          : entry,
      ),
    },
  };
  expectOwnerPush(
    runtime,
    'canon',
    sources.canon,
    next,
    'page.items',
    'canon-sibling',
    'canonModels().assetCanon.items[1].title',
    'Changed canon sibling',
  );
  expect(runtime.models).not.toHaveBeenCalled();
});

it('binds document annotations to the held file identity and stops presenting a previous file review', () => {
  const file = { path: 'note.md', absolutePath: '/project/note.md', sha256: 'abc' };
  const sources = {
    workbench: { ...fixtureWorkbenchSource(), opened: { worktreeId: 'workspace', file } },
    document: {
      selection: null,
      quote: null,
      snapshot: {
        worktreeId: 'workspace',
        file,
        review: {
          error: null,
          view: {
            canWrite: true,
            canReply: true,
            review: {
              annotations: [
                {
                  id: 'opinion',
                  body: 'Owner opinion',
                  state: 'open',
                  anchor: { kind: 'text_quote', quote: 'Original text' },
                  replies: [],
                },
                {
                  id: 'document-sibling',
                  body: 'Sibling opinion',
                  state: 'open',
                  anchor: { kind: 'text_quote', quote: 'Sibling text' },
                  replies: [],
                },
              ],
            },
          },
        },
        quotes: { quotes: [] },
        listen: { active: false },
        session: null,
      },
    },
  };
  const runtime = consoleSource(sources);
  expect(runtime.read('documentModels().documentReview.annotations[0].title')).toBe('Owner opinion');
  expect(runtime.read('documentModels().documentAnnotations[0].quote')).toBe('Original text');
  let next = { ...sources.document };
  next = {
    ...next,
    snapshot: {
      ...next.snapshot,
      review: {
        ...next.snapshot.review,
        view: {
          ...next.snapshot.review.view,
          review: {
            ...next.snapshot.review.view.review,
            annotations: next.snapshot.review.view.review.annotations.map((entry, index) =>
              index === 1
                ? { ...next.snapshot.review.view.review.annotations[1], body: 'Changed document sibling' }
                : entry,
            ),
          },
        },
      },
    },
  };
  expectOwnerPush(
    runtime,
    'document',
    sources.document,
    next,
    'snapshot.review.view.review.annotations',
    'document-sibling',
    'documentModels().documentReview.annotations[1].title',
    'Changed document sibling',
  );
  sources.workbench.opened.file = { ...file, sha256: 'changed' };
  runtime.push({ workbench: sources.workbench });
  expect(runtime.read('documentModels().documentReview')).toBeNull();
  expect(runtime.models).not.toHaveBeenCalled();
});

it('projects exact artwork and review sources from held records while retaining console view choices', () => {
  const work = {
    type: 'image',
    name: 'Owner artwork',
    createdAt: 1,
    catId: 'codex',
    threadId: 'source-thread',
    navigationId: 'work-owner',
    url: '/uploads/owner.png',
    work: { contentRef: 'owner', ownerRevision: 1, currentOwnerRevision: 1 },
    sourceFacts: {
      content: { kind: 'image' },
      fileSource: { kind: 'url', url: '/uploads/owner.png' },
      mediaUrl: 'https://api.test/uploads/owner.png',
    },
  };
  const view = structuredClone(initial);
  const sources = {
    reviews: {
      artifacts: {
        works: [work, { ...work, navigationId: 'review-sibling', name: 'Sibling artwork' }],
        complete: true,
        loading: false,
        error: false,
      },
      global: { works: [], artifacts: [], complete: true, loading: false, error: false },
      recentOwners: [],
      globalEnabled: false,
      widgets: {},
      openedWork: { artifact: work },
      workMetadata: null,
      text: { content: null, loading: false, error: false },
      contexts: [],
      load: '',
      history: { entries: [], nextCursor: null },
      historyLoad: '',
      error: '',
      reviewId: view.review.reviewId,
      round: view.review.rounds[0].number,
      review: { view, round: view.review.rounds[0].number, src: 'blob:owner', download: 'blob:download' },
      requestSources: Object.fromEntries(
        view.review.rounds.map((round) => [round.number, artifactRoundRequestSource(view, round)]),
      ),
      modification: null,
    },
  };
  const runtime = consoleSource(sources, {
    review: { work: 'work-owner', round: null, draft: null, edit: null, compare: null, markup: null },
  });
  const before = JSON.stringify(sources);
  expect(runtime.read('reviewsModels().work.id')).toBe('work-owner');
  expect(runtime.read('reviewsModels().works.items[0].name')).toBe('Owner artwork');
  expect(runtime.read('reviewsModels().mediaReview.media.src')).toBe('blob:owner');
  expect(JSON.stringify(sources)).toBe(before);
  let next = { ...sources.reviews };
  next = {
    ...next,
    artifacts: {
      ...next.artifacts,
      works: next.artifacts.works.map((entry, index) =>
        index === 1 ? { ...next.artifacts.works[1], name: 'Changed review sibling' } : entry,
      ),
    },
  };
  expectOwnerPush(
    runtime,
    'reviews',
    sources.reviews,
    next,
    'artifacts.works',
    'review-sibling',
    'reviewsModels().works.items[1].name',
    'Changed review sibling',
  );
  expect(runtime.models).not.toHaveBeenCalled();
});

it('projects film story and catalogue from held project documents without host models', () => {
  const document = videoProjectDocumentSchema.parse(project());
  const owner = { contentRef: 'film-owner', ownerRevision: 1, blobDigest: digest, document };
  const sources = {
    film: {
      projects: [owner, { ...owner, contentRef: 'film-sibling', document: { ...document, title: 'Sibling film' } }],
      load: '',
      reference: null,
      selected: {
        head: owner,
        input: owner,
        descriptor: null,
        review: { annotations: [], revision: 1 },
        sync: null,
        facts: null,
      },
    },
  };
  const before = JSON.stringify(sources);
  const runtime = consoleSource(sources);
  for (let i = 0; i < 30; i++) {
    expect(runtime.read('filmModels().filmProject.title')).toBe(document.title);
    expect(runtime.read('filmModels().filmProject.story.length')).toBe(document.timeline.segments.length);
    expect(runtime.read('filmModels().cafeWsClips.items[0].key')).toBe('film-owner');
  }
  expect(JSON.stringify(sources)).toBe(before);
  let next = { ...sources.film };
  next = {
    ...next,
    projects: next.projects.map((entry, index) =>
      index === 1
        ? { ...next.projects[1], document: { ...next.projects[1].document, title: 'Changed film sibling' } }
        : entry,
    ),
  };
  expectOwnerPush(
    runtime,
    'film',
    sources.film,
    next,
    'projects',
    'film-sibling',
    'filmModels().cafeWsClips.items[1].title',
    'Changed film sibling',
  );
  expect(runtime.models).not.toHaveBeenCalled();
});
