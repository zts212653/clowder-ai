import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { getDefaultUploadDir } from '../../dist/utils/upload-paths.js';
import { imageFixture, SYNTHETIC_PNG } from '../helpers/acp-image-fixture.js';

const ENVIRONMENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64',
);

function service(client, root) {
  return new AcpAgentService({
    catId: 'codex',
    projectRoot: root,
    mcpSupport: false,
    mcpServers: [],
    poolKey: { projectPath: root, providerProfile: 'synthetic' },
    pool: {
      async acquire(poolKey) {
        return { client, poolKey, release() {} };
      },
      rememberSession() {},
    },
  });
}

for (const transport of ['stdio', 'httpstream']) {
  for (const scenario of [
    'override-only',
    'same-name',
    'invalid-override',
    'escape-override',
    'override-no-env',
    'default',
  ]) {
    test(`#1598 ${transport} uploadDir: ${scenario}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'acp-upload-dir-'));
      const envRoot = join(root, 'environment');
      const override = join(root, 'override');
      await mkdir(envRoot);
      await mkdir(override);
      const previous = process.env.UPLOAD_DIR;
      const filename = `image-${randomUUID()}.png`;
      const selectedBytes = SYNTHETIC_PNG;
      let url = `/uploads/${filename}`;
      let uploadDir = override;
      let defaultImagePath;
      process.env.UPLOAD_DIR = envRoot;
      if (scenario === 'override-no-env') delete process.env.UPLOAD_DIR;
      if (scenario === 'default') {
        delete process.env.UPLOAD_DIR;
        uploadDir = undefined;
        await mkdir(getDefaultUploadDir(), { recursive: true });
        defaultImagePath = join(getDefaultUploadDir(), filename);
        await writeFile(defaultImagePath, selectedBytes);
      } else {
        await writeFile(join(override, filename), selectedBytes);
      }
      if (scenario === 'same-name' || scenario === 'invalid-override') {
        await writeFile(join(envRoot, filename), ENVIRONMENT_PNG);
      }
      if (scenario === 'invalid-override') uploadDir = join(root, 'missing-root');
      if (scenario === 'escape-override') {
        await writeFile(join(envRoot, filename), selectedBytes);
        await symlink(envRoot, join(override, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
        url = `/uploads/outside/${filename}`;
      }
      let fixture;
      try {
        fixture = await imageFixture(transport, root);
        const messages = [];
        for await (const message of service(fixture.client, root).invoke('Describe attached image.', {
          uploadDir,
          contentBlocks: [{ type: 'image', url }],
        }))
          messages.push(message);
        const errors = messages.filter((message) => message.type === 'error');
        const prompts = fixture.captured.filter((message) => message.method === 'session/prompt');
        if (scenario === 'invalid-override' || scenario === 'escape-override') {
          assert.equal(
            errors[0]?.errorCode,
            scenario === 'invalid-override' ? 'image_input_unavailable' : 'image_input_invalid',
          );
          assert.equal(prompts.length, 0, 'must not fall back to the environment directory or escape selected root');
          assert.equal(fixture.captured.filter((message) => message.method === 'session/new').length, 0);
        } else {
          assert.equal(errors.length, 0, JSON.stringify(errors));
          assert.equal(prompts.length, 1);
          assert.deepEqual(
            prompts[0].params.prompt.filter((block) => block.type === 'image'),
            [
              {
                type: 'image',
                mimeType: 'image/png',
                data: selectedBytes.toString('base64'),
              },
            ],
          );
        }
      } finally {
        await fixture?.close();
        if (defaultImagePath) await rm(defaultImagePath, { force: true });
        await rm(root, { recursive: true, force: true });
        if (previous === undefined) delete process.env.UPLOAD_DIR;
        else process.env.UPLOAD_DIR = previous;
      }
    });
  }
}
