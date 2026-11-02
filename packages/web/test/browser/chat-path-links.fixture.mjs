import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createWorkspaceContentReviewComposition } from '../../../api/dist/domains/collaborative-content/workspace-review/composition.js';
import { resolveWorkspaceContentRoot } from '../../../api/dist/domains/workspace/workspace-content-source-factory.js';
import { workspaceRoutes } from '../../../api/dist/routes/workspace.js';
import { registerWorkspaceContentReviewRoutes } from '../../../api/dist/routes/workspace-content-review-routes.js';
import { seedChatPathDesignSample } from './chat-path-design.fixture.mjs';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url));
function office(member, xml) {
  const name = Buffer.from(member),
    compressed = deflateRawSync(Buffer.from(xml));
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(Buffer.byteLength(xml), 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}
/** Real persisted message, Git objects, files, owner thread and Workspace routes. No provider or desktop action runs. */
export async function createChatPathFixture(language) {
  return createInboxProposalFixture({
    configureRuntime: async ({ app, owner, threads, messages }) => {
      const root = await mkdtemp(path.join(tmpdir(), 'f322-chat-paths-'));
      const reviewState = await mkdtemp(path.join(tmpdir(), 'f322-chat-reviews-'));
      let reviews;
      const fileSourceRequests = [];
      app.addHook('onSend', async (request, reply, payload) => {
        if (request.url === '/api/workspace/resolve-file-source' && fileSourceRequests.length < 64) {
          let response;
          try {
            response = JSON.parse(String(payload));
          } catch {
            response = String(payload);
          }
          fileSourceRequests.push({ body: request.body, status: reply.statusCode, response });
        }
        return payload;
      });
      const closeReviews = () => {
        reviews?.store.close();
        reviews = undefined;
      };
      const priorLinkedRoots = process.env.WORKSPACE_LINKED_ROOTS;
      const restoreLinkedRoots = () => {
        if (priorLinkedRoots === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
        else process.env.WORKSPACE_LINKED_ROOTS = priorLinkedRoots;
      };
      const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
      try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Controlled local sample');
        git('config', 'user.email', 'fixture@invalid.test');
        git('remote', 'add', 'origin', 'https://github.com/zts212653/clowder-ai.git');
        await mkdir(path.join(root, 'docs'));
        await mkdir(path.join(root, 'images'));
        await writeFile(
          path.join(root, 'docs', 'delivery.md'),
          '# Delivery notes\n\nVerified local file.\n\nLine five stays here.\n',
        );
        await writeFile(path.join(root, 'docs', 'later-deleted.md'), 'Present at first read');
        await writeFile(path.join(root, 'docs', 'archive.7z'), 'A named archive, initially present');
        await mkdir(path.join(root, 'packages/web'), { recursive: true });
        await mkdir(path.join(root, 'packages/shared'));
        await writeFile(path.join(root, 'packages/shared/index.md'), '# Parent reference\n\nSame admitted root.\n');
        const alias = path.join(reviewState, 'project-alias');
        await symlink(root, alias, 'dir');
        await writeFile(path.join(root, 'README'), 'Extensionless document\n');
        await copyFile(path.join(web, 'public/avatars/family/codex61-sol.png'), path.join(root, 'images', 'sol.png'));
        for (const [file, member, xml] of [
          ['slides.pptx', 'docProps/app.xml', '<Properties><Slides>6</Slides></Properties>'],
          ['report.docx', 'docProps/app.xml', '<Properties><Pages>12</Pages></Properties>'],
          [
            'data.xlsx',
            'xl/workbook.xml',
            '<workbook><sheets><sheet name="One"/><sheet name="Two"/></sheets></workbook>',
          ],
        ])
          await writeFile(path.join(root, 'docs', file), office(member, xml));
        await writeFile(path.join(root, '.env.local'), 'CONTROLLED_SECRET_MUST_NOT_APPEAR=fixture-only');
        git('add', '.');
        git('commit', '-qm', 'Deliver the verified path sample');
        const sha = git('rev-parse', 'HEAD');
        // A metadata-only registry alias is not an F063 content grant. Use the normal admitted root inventory.
        process.env.WORKSPACE_LINKED_ROOTS = `chat-path-links-fixture:${root}`;
        assert.equal((await resolveWorkspaceContentRoot('linked_chat-path-links-fixture')).root, await realpath(root));
        const thread = threads.create(owner, language === 'en' ? 'Files ready to open' : '文件都在这里', root);
        const words =
          language === 'en'
            ? 'The notes are in `docs/delivery.md:5`; this image is `images/sol.png`. The old file `docs/not-here.md` is missing. See [the merged approval work](https://github.com/zts212653/clowder-ai/pull/5963).'
            : '说明在 `docs/delivery.md:5`，图片在 `images/sol.png`。旧文件 `docs/not-here.md` 已经找不到；审批结果见[这条已合入的 PR](https://github.com/zts212653/clowder-ai/pull/5963)。';
        const content =
          words +
          '\n\n`docs/slides.pptx`\n\n`images/sol.png`\n\n' +
          (language === 'en' ? 'Also: ' : '其他：') +
          '`' +
          sha.slice(0, 10) +
          '` · [example.com](https://example.com/article)\n\n' +
          '`docs/report.docx` `docs/data.xlsx`\n\n`docs/`\n\n[Local GitHub file](https://github.com/zts212653/clowder-ai/blob/main/docs/delivery.md#L3)\n\n`docs/later-deleted.md`\n\n```sh\ncat docs/delivery.md\n```';
        const message = messages.append({
          userId: owner,
          threadId: thread.id,
          from: { kind: 'agent', catId: 'codex61-sol' },
          content,
          timestamp: Date.now(),
        });
        const plugin = messages.append({
          userId: owner,
          threadId: thread.id,
          from: { kind: 'plugin', instanceId: 'sample-plugin-instance' },
          content: '[Delivery notes](docs/delivery.md:3)',
          timestamp: Date.now(),
          extra: {
            pluginMessage: {
              instanceId: 'sample-plugin-instance',
              revision: 1,
              provenance: { kind: 'controlled-local-fixture' },
              presentation: { connector: 'sample-plugin', label: 'Sample plugin', icon: 'link' },
              elements: [{ type: 'markdown', text: '[Delivery notes](docs/delivery.md:3)' }],
            },
          },
        });
        const ordinary = [
          'zh/en',
          'F225/F231',
          'PPT/Word/Excel',
          '@cat-cafe/shared',
          'owner/repo',
          '16/9.5',
          '2026/10/23',
          'v1.2',
          '127.0.0.1',
        ];
        const regression = messages.append({
          userId: owner,
          threadId: thread.id,
          from: { kind: 'agent', catId: 'codex61-sol' },
          timestamp: Date.now(),
          content:
            ordinary.join(' ') +
            '\n\n' +
            ordinary.map((word) => '`' + word + '`').join(' ') +
            '\n\n`docs/delivery.md:3` [wt:linked_chat-path-links-fixture] and docs/removed-root.md[wt:unregistered-history]' +
            '\n\n`unverified.option`\n`another.value`',
        });
        const multiline = messages.append({
          userId: owner,
          threadId: thread.id,
          from: { kind: 'agent', catId: 'codex61-sol' },
          timestamp: Date.now(),
          content: '`docs/delivery.md`\n`docs/report.docx`\n`docs/data.xlsx`',
        });
        const lifecycleThread = threads.create(owner, 'Path lifecycle', path.join(root, 'packages/web'));
        const lifecycle = messages.append({
          userId: owner,
          threadId: lifecycleThread.id,
          from: { kind: 'agent', catId: 'codex61-sol' },
          timestamp: Date.now(),
          content: '`../shared/index.md:2`\n\n`../shared/gone.md`\n\n`' + path.join(alias, 'docs/archive.7z') + '`',
        });
        const design = await seedChatPathDesignSample({ app, root, owner, threads, messages, language });
        await app.register(workspaceRoutes, { threadStore: threads });
        reviews = createWorkspaceContentReviewComposition({ dataDir: reviewState, ownerUserId: owner });
        registerWorkspaceContentReviewRoutes(app, {
          reviews: reviews.reviews,
          fileQuotes: { source: reviews.source, messages, threads },
        });
        app.addHook('onClose', async () => closeReviews());
        return {
          root,
          sha,
          thread,
          message,
          plugin,
          regression,
          multiline,
          lifecycleThread,
          lifecycle,
          fileSourceRequests,
          ordinary,
          design,
          close: async () => {
            closeReviews();
            restoreLinkedRoots();
            await Promise.all([root, reviewState].map((directory) => rm(directory, { recursive: true, force: true })));
          },
        };
      } catch (error) {
        closeReviews();
        restoreLinkedRoots();
        await Promise.all([root, reviewState].map((directory) => rm(directory, { recursive: true, force: true })));
        throw error;
      }
    },
  });
}
