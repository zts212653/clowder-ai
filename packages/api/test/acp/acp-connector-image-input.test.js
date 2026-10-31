import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { readAcpImageBlocks } from '../../dist/domains/cats/services/agents/providers/acp/acp-image-input.js';
import { FileMessagingMediaLedger } from '../../dist/domains/messaging/media-ledger.js';
import { imageFixture, SYNTHETIC_PNG } from '../helpers/acp-image-fixture.js';

for (const transport of ['stdio', 'httpstream']) {
  for (const scenario of [
    'host-media-ledger',
    'retained-media-route',
    'mixed-roots',
    'default-root',
    'traversal',
    'encoded-traversal',
    'symlink',
    'missing',
  ]) {
    test(`ACP ${transport} connector image: ${scenario}`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-connector-image-')));
      const oldMediaDir = process.env.CONNECTOR_MEDIA_DIR;
      const oldCwd = process.cwd();
      const mediaDir = scenario === 'default-root' ? join(root, 'data/connector-media') : join(root, 'connector-media');
      const uploadDir = join(root, 'uploads');
      let fixture;
      try {
        await mkdir(mediaDir, { recursive: true });
        await mkdir(uploadDir);
        process.env.CONNECTOR_MEDIA_DIR = mediaDir;
        if (scenario === 'default-root') {
          delete process.env.CONNECTOR_MEDIA_DIR;
          process.chdir(root);
        }
        // Legacy URL reading remains supported; plugin ingress now owns bytes through the Host ledger.
        await writeFile(join(mediaDir, 'downloaded.png'), SYNTHETIC_PNG);
        let contentBlocks = [{ type: 'image', url: '/api/connector-media/downloaded.png' }];
        let resolveTrustedImagePath;
        if (scenario === 'host-media-ledger') {
          const ledger = new FileMessagingMediaLedger(join(root, 'host-media'));
          const hmrId = await ledger.register(SYNTHETIC_PNG, {
            ownerInstanceId: 'fixture-plugin',
            mimeType: 'image/png',
          });
          contentBlocks = [{ type: 'image', url: `hmr:${hmrId}` }];
          resolveTrustedImagePath = (id) => ledger.resolveTrustedBlobPath(id);
        }
        if (scenario === 'mixed-roots') {
          await writeFile(join(uploadDir, 'web.png'), SYNTHETIC_PNG);
          contentBlocks = [{ type: 'image', url: '/uploads/web.png' }, ...contentBlocks];
        }
        if (scenario === 'traversal' || scenario === 'encoded-traversal') {
          await writeFile(join(root, 'outside.png'), SYNTHETIC_PNG);
          contentBlocks = [
            { type: 'image', url: `/api/connector-media/${scenario === 'traversal' ? '../' : '%2e%2e%2f'}outside.png` },
          ];
        }
        if (scenario === 'symlink') {
          const outside = join(root, 'outside');
          await mkdir(outside);
          await writeFile(join(outside, 'secret.png'), SYNTHETIC_PNG);
          await symlink(outside, join(mediaDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
          contentBlocks = [{ type: 'image', url: '/api/connector-media/escape/secret.png' }];
        }
        if (scenario === 'missing') contentBlocks = [{ type: 'image', url: '/api/connector-media/missing.png' }];
        fixture = await imageFixture(transport, root);
        const service = new AcpAgentService({
          catId: 'codex',
          projectRoot: root,
          mcpSupport: false,
          mcpServers: [],
          poolKey: { projectPath: root, providerProfile: 'synthetic' },
          pool: {
            async acquire(poolKey) {
              return { client: fixture.client, poolKey, release() {} };
            },
            rememberSession() {},
          },
        });
        const events = [];
        for await (const event of service.invoke('Describe this image.', {
          uploadDir,
          contentBlocks,
          resolveTrustedImagePath,
        }))
          events.push(event);
        const errors = events.filter((e) => e.type === 'error');
        const prompts = fixture.captured.filter((m) => m.method === 'session/prompt');
        if (['traversal', 'encoded-traversal', 'symlink', 'missing'].includes(scenario)) {
          assert.equal(
            errors[0]?.errorCode,
            scenario === 'missing' ? 'image_input_unavailable' : 'image_input_invalid',
          );
          assert.equal(prompts.length, 0);
          assert.equal(fixture.captured.filter((m) => m.method === 'session/new').length, 0);
        } else {
          assert.deepEqual(errors, [], 'an IM attachment must reach the ACP prompt, not fail the entire turn');
          assert.equal(prompts.length, 1);
          assert.deepEqual(
            prompts[0].params.prompt.filter((b) => b.type === 'image'),
            contentBlocks.map(() => ({
              type: 'image',
              mimeType: 'image/png',
              data: SYNTHETIC_PNG.toString('base64'),
            })),
          );
        }
      } finally {
        await fixture?.close();
        process.chdir(oldCwd);
        if (oldMediaDir === undefined) delete process.env.CONNECTOR_MEDIA_DIR;
        else process.env.CONNECTOR_MEDIA_DIR = oldMediaDir;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const prefix of ['/uploads/', '/api/connector-media/']) {
  for (const [mimeType, bytes] of [
    ['image/png', SYNTHETIC_PNG],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x01])],
    ['image/gif', Buffer.from('GIF89a')],
    ['image/webp', Buffer.from('RIFF0000WEBP')],
    [null, Buffer.from('not an image')],
  ]) {
    test(`ACP ${prefix} derives ${mimeType ?? 'invalid'} from bytes, not the filename`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'acp-image-mime-'));
      const previous = process.env.CONNECTOR_MEDIA_DIR;
      try {
        process.env.CONNECTOR_MEDIA_DIR = root;
        await writeFile(join(root, 'mislabelled.jpg'), bytes);
        const read = () =>
          readAcpImageBlocks([{ type: 'image', url: `${prefix}mislabelled.jpg` }], { image: true }, undefined, root);
        if (mimeType === null) await assert.rejects(read, { code: 'image_input_invalid' });
        else assert.deepEqual(await read(), [{ type: 'image', mimeType, data: bytes.toString('base64') }]);
      } finally {
        if (previous === undefined) delete process.env.CONNECTOR_MEDIA_DIR;
        else process.env.CONNECTOR_MEDIA_DIR = previous;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
