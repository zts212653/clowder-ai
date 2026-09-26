/**
 * F202 C1 cross-repository gate: the pinned approved connector batch on the Host's real delivery path.
 *
 * Ledger acceptance covered here (formerly the W2-5p-H adapter smoke, which pinned older artifacts and
 * called the action directly):
 * - W2-5p-H: Host rich blocks reach a rich adapter unchanged, a text adapter renders them as plaintext,
 *   and an invalid historical block degrades before the adapter.
 * - W2-5f (5): the adapter shows the Host's display name (card header, formatted header or reply
 *   prefix), never the raw actor id.
 * - W2-5b (10): a Host file becomes a media_ref the adapter receives with its type, base-name fileName
 *   and complete bytes (multi-chunk); once the action returns the delivery grant is gone and the same
 *   hmr cannot be read; xiaoyi, which declares no media delivery, tells the reader instead.
 *
 * Runs with F202_W25PH_ARCHIVE_DIR pointing at the self-contained archives (release assets named in
 * `helpers/f202-connector-artifact-pins.js`); each archive must match its pinned SHA-256 or the test
 * fails. Scope: the admitted packages run in-process against a Host object composed from Host services
 * — a service-level cross-repo exercise, not a production carrier / process smoke.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderAllRichBlocksPlaintext } from '../dist/infrastructure/connectors/rich-block-plaintext.js';
import {
  admitAndLoad,
  createGateHost,
  DISPLAY_NAME,
  OWNER,
  RELEASES,
  shownAuthor,
  unavailable,
} from './helpers/f202-connector-artifact-gate.js';

const card = { id: 'card-1', kind: 'card', v: 1, title: 'Approval', bodyMarkdown: 'Review the proposal' };
const checklist = { id: 'checklist-1', kind: 'checklist', v: 1, title: 'Steps', items: [] };
/** Two full 512 KiB SDK chunks and a tail: the adapter must receive every byte in order. */
const reportBytes = randomBytes(2 * 512 * 1024 + 4099);

/**
 * The ordinary lane skips when the archives are not present. The mandatory lane
 * (`scripts/f202-connector-artifact-gate.mjs`) sets F202_ARTIFACT_GATE_REQUIRED=1: there a missing
 * archive fails, so a run can never pass by executing nothing (review P1, PR #1487 5830747045).
 */
const REQUIRED = process.env.F202_ARTIFACT_GATE_REQUIRED === '1';

async function withGate(release, context, run) {
  const reason = await unavailable(release);
  if (reason) {
    if (REQUIRED) assert.fail(`mandatory artifact gate: ${reason}`);
    context.skip(reason);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), `f202-gate-${release.name}-`));
  try {
    const loaded = await admitAndLoad(release, join(root, 'artifact'));
    const gate = await createGateHost(join(root, 'host'));
    const thread = await gate.threads.create(OWNER, `gate ${release.name}`);
    const pkg = await gate.start(release, loaded, thread.id);
    try {
      await run({ gate, pkg, threadId: thread.id, root: join(root, 'host') });
      assert.deepEqual(gate.failures, [], 'no publication failure');
      assert.deepEqual(gate.deliveryErrors, [], 'no delivery failure');
    } finally {
      await pkg.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const release of RELEASES) {
  test(`${release.name}: rich and plain Host replies reach the adapter under the cat's display name`, async (context) => {
    await withGate(release, context, async ({ gate, pkg, threadId }) => {
      const richEnvelope = await gate.catReply(threadId, [card, checklist]);
      const rich = pkg.probe.take();
      await gate.catReply(threadId, []);
      const plain = pkg.probe.take();

      assert.deepEqual(
        richEnvelope.payload.elements.map(({ kind }) => kind),
        ['text', 'rich_block', 'rich_block'],
      );
      assert.equal(rich.length, 1, 'one adapter call for the rich reply');
      assert.equal(plain.length, 1, 'one adapter call for the plain reply');
      for (const call of [...rich, ...plain]) {
        assert.equal(shownAuthor(call), DISPLAY_NAME, `${release.name} ${call.method} shows the display name`);
      }
      const [richCall] = rich;
      if (richCall.method === 'sendRichMessage') {
        assert.equal(JSON.stringify(richCall.args[2]), JSON.stringify([card, checklist]), 'blocks arrive unchanged');
      } else {
        assert.equal(richCall.method, 'sendReply');
        assert.ok(richCall.args[1].endsWith(`\n\n${renderAllRichBlocksPlaintext([card, checklist])}`));
      }
    });
  });

  test(`${release.name}: a Host file reaches the adapter whole, and its grant ends with the action`, async (context) => {
    await withGate(release, context, async ({ gate, pkg, threadId, root }) => {
      await writeFile(join(root, 'uploads', 'report.pdf'), reportBytes);
      const envelope = await gate.catReply(threadId, [
        { id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'C:\\private\\secrets\\report.pdf' },
      ]);
      const calls = pkg.probe.take();

      const ref = envelope.payload.elements.find(({ kind }) => kind === 'media_ref');
      assert.equal(ref?.payload.type, 'file');
      assert.equal(ref.payload.fileName, 'report.pdf');
      const sent = calls.filter(({ method }) => method === 'sendMedia');
      assert.equal(pkg.grants.includes('media.read'), release.media, 'media delivery follows the declared capability');
      if (release.media) {
        assert.equal(sent.length, 1, 'one media upload');
        const [externalId, media] = sent[0].args;
        assert.equal(externalId, 'external-1');
        assert.equal(media.type, 'file');
        assert.equal(media.fileName, 'report.pdf');
        assert.ok(media.content.equals(reportBytes), 'complete bytes, in order');
      } else {
        assert.deepEqual(sent, [], 'no media upload where the package declares none');
        assert.ok(
          calls.some(
            ({ method, args }) =>
              method === 'sendReply' && args[1] === `【${DISPLAY_NAME}🐱】\n⚠️ 这条文件无法在小艺里发送`,
          ),
          'the reader is told the file cannot be sent',
        );
      }
      // A package that reads media loses the delivery grant when its action returns; one that
      // declares no media.read is refused before any grant is consulted.
      await assert.rejects(
        pkg.media.read({ reference: ref.payload.reference, offset: 0, limit: 1024 }),
        (error) => error?.code === (release.media ? 'MEDIA_ACCESS_DENIED' : 'PERMISSION'),
        release.media ? 'the delivery grant ends when the action returns' : 'no media.read, no Host media',
      );
    });
  });
}

test('an invalid historical Host block degrades before reaching the adapter', async (context) => {
  const release = RELEASES.find(({ name }) => name === 'feishu');
  await withGate(release, context, async ({ gate, pkg, threadId }) => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    let envelope;
    try {
      envelope = await gate.catReply(threadId, [{ ...card, v: 2 }]);
    } finally {
      console.warn = originalWarn;
    }
    const calls = pkg.probe.take();
    assert.deepEqual(
      envelope.payload.elements.map(({ kind }) => kind),
      ['text', 'text'],
    );
    assert.equal(warnings.find((args) => args[1]?.reason === 'invalid_shape')?.[1].reason, 'invalid_shape');
    assert.deepEqual(
      calls.map(({ method }) => method),
      ['sendFormattedReply'],
    );
    assert.equal(calls[0].args[1].body, 'rich reply\n\n[card: Approval]');
    assert.equal(calls[0].args[1].header, DISPLAY_NAME);
  });
});
