import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { parse } from 'yaml';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { TasteMemoryLifecycleService } from '../dist/domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from '../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from '../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { parseTasteVignette } from '../dist/domains/memory/taste/TasteMemoryReader.js';
import { tasteDocumentAnchor, tasteMemoryId } from '../dist/domains/memory/taste/taste-memory-identity.js';
import { TastePublicationIndeterminateError } from '../dist/domains/taste/services/GitTastePublisher.js';
import { formatVignette } from '../dist/domains/taste/services/writeVignette.js';

const ownerUserId = 'public-taste-owner';
const sourcePath = 'docs/taste/vignettes/public-lifecycle.md';
const initialContent =
  '---\nwhen: 2026-10-06\nquotes: ["Public quote"]\nscene: "Public scene"\ntags: ["public"]\ndimension: visual-quality\nprivacy: public\n---\n';

const revisionOf = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

describe('F321 public Taste projection', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'f321-public-taste-'));
    roots.push(root);
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    writeFileSync(join(root, sourcePath), initialContent, 'utf8');
    writeFileSync(
      join(root, 'docs/taste/index.md'),
      '# Taste Index\n\n- [**public**](vignettes/public-lifecycle.md)\n  - 搜索词：public\n  - 场景：Public scene\n',
      'utf8',
    );
    return {
      root,
      repository: {
        canonicalRoot: () => root,
        gitCheckoutRoot: () => root,
        approvalLockKey: () => 'public-taste-test',
      },
    };
  }

  it('records the target revision before publishing and removes public canonical/index content on forget', async () => {
    assert.equal(tasteDocumentAnchor(sourcePath), 'doc:taste/vignettes/public-lifecycle');
    const { root, repository } = fixture();
    const publicationStates = [];
    const writer = new TasteMemoryProjectionWriter(repository, {
      publishProjection: async (input) => {
        const state = input.materialize(root);
        publicationStates.push(state);
        return { commitSha: 'a'.repeat(40), alreadyPublished: state === 'already-published' };
      },
    });
    const initialRevision = revisionOf(initialContent);
    let recordedRevision;
    const corrected = await writer.apply({
      ownerUserId,
      sourcePath,
      command: {
        action: 'correct',
        requestId: 'public-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: initialRevision,
        patch: { scene: 'Corrected public scene' },
      },
      recordTargetRevision: (revision) => {
        assert.equal(readFileSync(join(root, sourcePath), 'utf8'), initialContent);
        recordedRevision = revision;
      },
    });
    assert.equal(corrected.revision, recordedRevision);
    assert.match(readFileSync(join(root, 'docs/taste/index.md'), 'utf8'), /Corrected public scene/u);

    const retired = await writer.apply({
      ownerUserId,
      sourcePath,
      command: {
        action: 'retire',
        requestId: 'public-retire:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: corrected.revision,
      },
      recordTargetRevision: () => {},
    });
    assert.equal(retired.status, 'retired');
    assert.equal(readFileSync(join(root, 'docs/taste/index.md'), 'utf8').includes('public-lifecycle.md'), false);

    const forgetCommand = {
      action: 'hard_forget',
      requestId: 'public-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: retired.revision,
      confirmed: true,
    };
    const forgotten = await writer.apply({
      ownerUserId,
      sourcePath,
      command: forgetCommand,
      recordTargetRevision: (revision) => {
        assert.equal(revision, null);
        assert.equal(existsSync(join(root, sourcePath)), true);
      },
    });
    assert.deepEqual(forgotten, { sourcePath, revision: null, status: 'forgotten' });
    assert.equal(existsSync(join(root, sourcePath)), false);
    const tombstoneName = `${createHash('sha256').update(sourcePath).digest('hex')}.json`;
    const tombstone = readFileSync(join(root, 'docs/taste/tombstones', tombstoneName), 'utf8');
    assert.equal(tombstone.includes(ownerUserId), false);
    assert.equal(JSON.parse(tombstone).ownerDigest, createHash('sha256').update(ownerUserId).digest('hex'));
    assert.deepEqual(publicationStates, ['changed', 'changed', 'changed']);

    const replay = await writer.apply({
      ownerUserId,
      sourcePath,
      command: forgetCommand,
      recordTargetRevision: () => {},
    });
    assert.equal(replay.status, 'forgotten');
    assert.equal(publicationStates.at(-1), 'already-published');
  });

  it('re-serializing on retire keeps scalar values intact while no line ends with blank space', async () => {
    const { root, repository } = fixture();
    // Folded at the default line width, this quote put an escaped space at a line end; stripping it turned the
    // escape into a line continuation and deleted the newline. A no-break space is content, not git whitespace.
    const quote = `${'word '.repeat(30)} \nbeta`;
    const content = `---\nwhen: 2026-10-06\nquotes: [${JSON.stringify(quote)}]\nscene: |-\n\n  line one \n  line two  \ntags: ["public"]\ndimension: visual-quality\nprivacy: public\n---\n`;
    writeFileSync(join(root, sourcePath), content, 'utf8');
    const writer = new TasteMemoryProjectionWriter(repository, {
      publishProjection: async (input) => {
        const state = input.materialize(root);
        return { commitSha: 'a'.repeat(40), alreadyPublished: state === 'already-published' };
      },
    });
    await writer.apply({
      ownerUserId,
      sourcePath,
      command: {
        action: 'retire',
        requestId: 'public-retire-scalars:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: revisionOf(content),
      },
      recordTargetRevision: () => {},
    });
    const retired = readFileSync(join(root, sourcePath), 'utf8');
    assert.deepEqual(
      retired.split('\n').filter((line) => /[ \t]$/.test(line)),
      [],
    );
    const parsed = parse(/^---\n([\s\S]*?)\n---/.exec(retired)[1]);
    assert.equal(parsed.status, 'retired');
    assert.equal(parsed.quotes[0], `${'word '.repeat(30).trimEnd()}\nbeta`);
    assert.equal(parsed.scene, '\nline one \nline two');
  });

  it('retire reads back every value for line separators, spaced keys, comments and final block scalars', async () => {
    const head = 'when: 2026-10-06\nquotes: ["q"]\ntags: ["t"]\ndimension: visual-quality\nprivacy: public\n';
    const cases = {
      lineSeparator: `${head}scene: |-\n  alpha\n   beta\n`,
      spacedKey: `${head}scene: "s"\n"scene ": "extra"\n`,
      comment: `when: 2026-10-06\nquotes: ["old"] # note  \nscene: "s"\ntags: ["t"]\ndimension: visual-quality\nprivacy: public\n`,
      keptFinalLines: `${head}status: approved\nscene: |+\n  alpha\n\n\n`,
      finalNoBreakSpace: `${head}status: approved\nscene: |-\n  alpha \n`,
      collectionKeys: `${head}scene: "s"\n? ["scene "]\n: "a"\n? ["scene"]\n: "b"\n`,
      commentAboveKey: `${head}# lead note  \nscene: "s"\n`,
    };
    for (const [name, yaml] of Object.entries(cases)) {
      const { root, repository } = fixture();
      const content = `---\n${yaml}---\n`;
      writeFileSync(join(root, sourcePath), content, 'utf8');
      const writer = new TasteMemoryProjectionWriter(repository, {
        publishProjection: async (input) => {
          const state = input.materialize(root);
          return { commitSha: 'a'.repeat(40), alreadyPublished: state === 'already-published' };
        },
      });
      await writer.apply({
        ownerUserId,
        sourcePath,
        command: {
          action: 'retire',
          requestId: `public-retire-${name}:018f2d5e-9f45-7d8c-a829-88f6440a4f15`,
          expectedRevision: revisionOf(content),
        },
        recordTargetRevision: () => {},
      });
      const frontmatter = (text) => /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)[1];
      const retired = readFileSync(join(root, sourcePath), 'utf8');
      const { status, ...after } = parse(frontmatter(retired));
      const { status: _before, ...before } = parse(frontmatter(content));
      assert.equal(status, 'retired', name);
      assert.deepEqual(after, before, name);
      assert.deepEqual(
        retired.split('\n').filter((line) => /[ \t\r\v\f]$/.test(line)),
        [],
        name,
      );
    }
  });

  const proposalWith = (fields) => ({
    id: 'proposal_bytes_abc123',
    userId: ownerUserId,
    catId: 'codex-sol',
    threadId: 'thread-bytes',
    scene: 'scene',
    quote: 'quote',
    tags: ['bytes'],
    dimension: 'visual-quality',
    privacy: 'public',
    status: 'approving',
    createdAt: 1787620000000,
    ...fields,
  });

  // Recovery compares a retried vignette byte for byte with the published one, so a readable vignette
  // published before this change must be produced again unchanged. This is the formatter as released
  // up to origin/main 7dd94a10ab, kept frozen as the oracle.
  const releasedQuoted = (s) =>
    s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  const releasedVignette = (p) => {
    const sceneLines = p.scene.split('\n');
    const scene =
      sceneLines.length === 1 ? `>\n  ${sceneLines[0]}` : `>\n${sceneLines.map((l) => `  ${l}`).join('\n')}`;
    return [
      '---',
      `when: ${new Date(p.createdAt).toISOString().slice(0, 10)}`,
      'quotes:',
      `  - "${releasedQuoted(p.quote)}"`,
      ...(p.takeaway ? [`takeaway: "${releasedQuoted(p.takeaway)}"`] : []),
      `scene: ${scene}`,
      `tags: [${p.tags.map((t) => `"${releasedQuoted(t)}"`).join(', ')}]`,
      `dimension: ${p.dimension}`,
      `privacy: ${p.privacy}`,
      `catId: ${p.catId}`,
      `proposalId: ${p.id}`,
      '---',
      '',
    ].join('\n');
  };

  it('approval keeps the exact bytes of every vignette the previous formatter published readable', () => {
    const inputs = [
      {},
      { quote: 'Keep\rit compact.' },
      { scene: 'alpha\n  more indented\nbeta' },
      { scene: ' single leading space' },
      { scene: ' alpha\n beta' },
      { quote: 'say "hi"\tnow\\', takeaway: 'line\nbreak', tags: ['a b', '标签'] },
      // A less indented line is read as a comment, not an error: the released form was readable.
      { scene: ' alpha\n#note' },
      { scene: '\u00a0\n alpha\nbeta' },
      { scene: 'alpha\rbeta' },
    ];
    for (const fields of inputs) {
      const proposal = proposalWith(fields);
      const expected = releasedVignette(proposal);
      assert.ok(parseTasteVignette(expected, 'public', false), JSON.stringify(fields));
      assert.equal(formatVignette(proposal), expected, JSON.stringify(fields));
    }
  });

  it('keeps a readable sensitive vignette whose released form ends a line with a blank: it is never committed', () => {
    const proposal = proposalWith({ privacy: 'sensitive', scene: 'alpha \nbeta' });
    const expected = releasedVignette(proposal);
    assert.ok(parseTasteVignette(expected, 'private', false));
    assert.equal(formatVignette(proposal), expected);
  });

  it('approval refuses when no form is publishable instead of writing a vignette the reader rejects', () => {
    // Kept line breaks count twice in the reader's payload limit: the folded released scene fits, the exact text does not.
    const fields = { scene: `${'x\n'.repeat(998)}x `, quote: '\u0001'.repeat(2000), takeaway: '\u0002'.repeat(250) };
    assert.throws(() => formatVignette(proposalWith(fields)), /cannot be written readable/);
    const sensitive = proposalWith({ ...fields, privacy: 'sensitive' });
    assert.equal(formatVignette(sensitive), releasedVignette(sensitive));
  });

  it('approval writes every proposal the released form could not publish readable as exact quoted text', () => {
    const cases = [
      { scene: ' alpha\nbeta' },
      { scene: ' \u00a0\nalpha' },
      { scene: ' alpha\n\u00a0' },
      { scene: ' alpha\n\u2028' },
      { scene: 'paragraph one\n\nparagraph two' },
      { scene: 'trailing space \nnext' },
      {
        scene: ' alpha\nbeta',
        quote: 'q\u2028\u2029\u0085\u007f\u0080\ufeff\r"\\\u0007\ud800 \u{1f431}',
        takeaway: 'k\t\u0000',
        tags: ['t\u00a0', 'say "x"'],
      },
    ];
    for (const fields of cases) {
      const proposal = proposalWith(fields);
      const content = formatVignette(proposal);
      const name = JSON.stringify(fields);
      assert.deepEqual(
        content.split('\n').filter((line) => /[ \t\r\v\f]$/.test(line)),
        [],
        name,
      );
      assert.match(content, /^scene: "/m, name);
      const frontmatter = parse(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)[1], { maxAliasCount: 0 });
      assert.equal(frontmatter.scene, proposal.scene, name);
      assert.deepEqual(frontmatter.quotes, [proposal.quote], name);
      assert.equal(frontmatter.takeaway, proposal.takeaway, name);
      assert.deepEqual(frontmatter.tags, proposal.tags, name);
      const parsed = parseTasteVignette(content, 'public', false);
      assert.ok(parsed, name);
      assert.equal(parsed.payload.scene, proposal.scene.trim(), name);
    }
  });

  it('recovers an indeterminate public push from exact prepared evidence without applying twice', async () => {
    const { root, repository } = fixture();
    let publications = 0;
    const writer = new TasteMemoryProjectionWriter(repository, {
      publishProjection: async (input) => {
        publications++;
        const state = input.materialize(root);
        if (publications === 1) throw new TastePublicationIndeterminateError('push acknowledgement lost');
        return { commitSha: 'b'.repeat(40), alreadyPublished: state === 'already-published' };
      },
    });
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new TasteMemoryLifecycleStore(db);
    const lifecycle = new TasteMemoryLifecycleService({
      store,
      writer,
      coordinator: new OwnerMemoryActionCoordinator({
        store: new InMemoryOwnerMemoryActionReceiptStore(),
        lock: new SessionMutex(),
      }),
      targetLock: new SessionMutex(),
      lockKey: repository.approvalLockKey,
      invalidateDerived: async () => {},
    });
    const command = {
      action: 'correct',
      requestId: 'public-recover:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: revisionOf(initialContent),
      patch: { scene: 'Exactly once after an uncertain push' },
    };
    await assert.rejects(
      lifecycle.executeOwnerAction(ownerUserId, tasteMemoryId(sourcePath), sourcePath, command),
      /push acknowledgement lost/u,
    );
    const firstContent = readFileSync(join(root, sourcePath), 'utf8');
    const recovered = await lifecycle.executeOwnerAction(ownerUserId, tasteMemoryId(sourcePath), sourcePath, command);
    assert.equal(recovered.outcome, 'applied');
    assert.equal(readFileSync(join(root, sourcePath), 'utf8'), firstContent);
    assert.equal(publications, 2);
    db.close();
  });
});
