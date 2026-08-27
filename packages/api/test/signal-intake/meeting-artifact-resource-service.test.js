import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMeetingArtifactDescriptor,
  MeetingArtifactResourceError,
  MeetingArtifactResourceService,
  MemorySourceAccessLeaseStore,
  SourceAccessLeaseService,
  SourceResolverRegistry,
} from '../../dist/domains/signal-intake/index.js';
import { estimateTokens } from '../../dist/utils/token-counter.js';
import { admissionHarness, publishInput } from './helpers.js';

const choices = {
  speakerMap: { alice: 'Alice', bob: 'Bob' },
  context: 'F292 bounded-reader dogfood',
  destinationHandle: 'host:private-thread:thread-1',
  outputs: ['minutes'],
};

async function harness(initialText) {
  const admission = await admissionHarness();
  await admission.service.publish(admission.binding, publishInput());
  let sourceText = initialText;
  let nextGrant = 1;
  const resolvers = new SourceResolverRegistry();
  resolvers.register({
    adapterId: 'resource-reader-test',
    supports: (handle) => handle.startsWith('example://'),
    resolve: async () => ({ contentType: 'text/plain', text: sourceText }),
  });
  const sources = new SourceAccessLeaseService({
    intakes: admission.intakes,
    leases: new MemorySourceAccessLeaseStore(),
    resolvers,
    createGrant: () => `resource-grant-${nextGrant++}`,
  });
  const artifact = createMeetingArtifactDescriptor({
    intakeId: 'intake-1',
    sourceHandle: 'example://meeting/artifact-1',
    contentType: 'text/plain',
    text: initialText,
  });
  const current = await admission.intakes.get('intake-1');
  const written = await admission.intakes.compareAndSet(current.intakeId, current.revision, {
    ...current,
    judgmentState: 'confirmed',
    executionState: 'succeeded',
    healthState: 'healthy',
    unresolved: [],
    choices,
    artifact,
    revision: current.revision + 1,
    updatedAt: 12_000,
  });
  assert.equal(written.outcome, 'written');
  const sourceMessage = {
    id: 'meeting-message-1',
    userId: 'owner-1',
    catId: null,
    threadId: 'thread-1',
    content: 'bounded envelope',
    mentions: ['codex-sol'],
    timestamp: 12_000,
    source: { connector: 'feishu', label: '飞书会议入站 / 录音豆', icon: 'feishu' },
    extra: {
      meetingArtifact: {
        intakeId: 'intake-1',
        sourceHandle: artifact.sourceHandle,
        resourceRef: artifact.resourceRef,
        sourceRevision: artifact.sourceRevision,
        byteLength: artifact.byteLength,
        contentType: artifact.contentType,
        trust: 'untrusted_external',
        instructionPolicy: 'data_only',
      },
    },
  };
  const service = new MeetingArtifactResourceService({
    intakes: admission.intakes,
    sources,
    messages: {
      getByIdempotencyKey: async (ownerId, threadId, key) =>
        ownerId === 'owner-1' &&
        threadId === 'thread-1' &&
        key === `meeting-artifact:intake-1:${artifact.sourceRevision}`
          ? sourceMessage
          : null,
    },
  });
  return { artifact, intake: written.intake, service, setSourceText: (value) => (sourceText = value) };
}

describe('F292 versioned meeting artifact reader', () => {
  it('reads a hostile long transcript through bounded resumable pages', async () => {
    const text = Array.from({ length: 36_000 }, (_, second) => {
      const hour = String(Math.floor(second / 3_600)).padStart(2, '0');
      const minute = String(Math.floor((second % 3_600) / 60)).padStart(2, '0');
      const remainingSecond = String(second % 60).padStart(2, '0');
      return `[${hour}:${minute}:${remainingSecond}] Alice: segment-${second}`;
    }).join('\n');
    const { artifact, service } = await harness(text);

    const overview = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'overview',
      maxChars: 600,
      maxTokens: 150,
    });
    assert.equal(overview.sourceRevision, artifact.sourceRevision);
    assert.equal(overview.provenance.trust, 'untrusted_external');
    assert.equal(overview.provenance.instructionPolicy, 'data_only');
    assert.ok(JSON.stringify(overview).length < 4_000);

    const outline = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'outline',
      maxChars: 220,
      maxTokens: 220,
    });
    assert.match(outline.content, /speaker=Alice/);
    assert.ok(outline.content.length <= 220);
    assert.ok(outline.nextCursor);

    const tinyOutline = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'outline',
      maxChars: 1,
      maxTokens: 1,
    });
    assert.equal(tinyOutline.content.length, 1);
    assert.ok(tinyOutline.nextCursor);
    const resumedTinyOutline = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'outline',
      maxChars: 1,
      maxTokens: 1,
      cursor: tinyOutline.nextCursor,
    });
    assert.notEqual(resumedTinyOutline.nextCursor, tinyOutline.nextCursor);

    const first = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'content',
      maxChars: 240,
      maxTokens: 60,
    });
    assert.ok(first.content.length <= 240);
    assert.ok(first.nextCursor);
    const second = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'content',
      maxChars: 240,
      maxTokens: 60,
      cursor: first.nextCursor,
    });
    assert.notEqual(second.content, first.content);
    assert.equal(first.content + second.content, text.slice(0, first.content.length + second.content.length));
  });

  it('filters by speaker and time while keeping external text data-only', async () => {
    const text = ['[00:00:01] Alice: first', '[00:00:02] Bob: hidden', '[00:00:03] Alice: second'].join('\n');
    const { artifact, service } = await harness(text);
    const result = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'content',
      speakers: ['Alice'],
      startTimeMs: 2_500,
      endTimeMs: 3_500,
      maxChars: 500,
      maxTokens: 125,
    });
    assert.match(result.content, /Alice: second/);
    assert.doesNotMatch(result.content, /first|Bob|hidden/);
    assert.deepEqual(result.filters, { speakers: ['Alice'], startTimeMs: 2_500, endTimeMs: 3_500 });
  });

  it('enforces maxTokens with the canonical tokenizer instead of a character-count proxy', async () => {
    const { artifact, service } = await harness('🧑‍💻'.repeat(20));
    const result = await service.read({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: artifact.resourceRef,
      view: 'content',
      maxChars: 100,
      maxTokens: 5,
    });
    assert.ok(estimateTokens(result.content) <= 5);
    assert.equal(result.estimatedTokens, estimateTokens(result.content));
    assert.ok(result.nextCursor);
  });

  it('rejects foreign cats and refuses to cross-read a changed source revision', async () => {
    const { artifact, service, setSourceText } = await harness('Alice: original revision');
    await assert.rejects(
      service.read({
        ownerId: 'owner-1',
        threadId: 'thread-1',
        catId: 'other-cat',
        resourceRef: artifact.resourceRef,
        view: 'content',
        maxChars: 100,
        maxTokens: 25,
      }),
      (error) => error instanceof MeetingArtifactResourceError && error.code === 'RESOURCE_FORBIDDEN',
    );

    setSourceText('Alice: mutated revision');
    await assert.rejects(
      service.read({
        ownerId: 'owner-1',
        threadId: 'thread-1',
        catId: 'codex-sol',
        resourceRef: artifact.resourceRef,
        view: 'content',
        maxChars: 100,
        maxTokens: 25,
      }),
      (error) => error instanceof MeetingArtifactResourceError && error.code === 'SOURCE_REVISION_CHANGED',
    );
  });

  it('rejects transcript bytes smuggled into durable intake metadata', async () => {
    const { intake } = await harness('Alice: source-owned bytes');
    const { parseMeetingIntake } = await import('../../dist/domains/signal-intake/meeting-intake-codec.js');
    assert.equal(parseMeetingIntake(JSON.stringify(intake)).artifact.resourceRef, intake.artifact.resourceRef);
    await assert.rejects(
      async () =>
        parseMeetingIntake(
          JSON.stringify({
            ...intake,
            artifact: { ...intake.artifact, transcript: 'must never become durable Host truth' },
          }),
        ),
      /meeting intake record is corrupt/,
    );
  });
});
