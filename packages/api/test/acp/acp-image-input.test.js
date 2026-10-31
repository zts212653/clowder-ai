import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { imageFixture, SYNTHETIC_PNG } from '../helpers/acp-image-fixture.js';

const directory = await mkdtemp(join(tmpdir(), 'acp-1598-'));
process.env.UPLOAD_DIR = directory;
await writeFile(join(directory, 'synthetic.png'), SYNTHETIC_PNG);
const images = [{ type: 'image', url: '/uploads/synthetic.png' }];
const expectedImage = { type: 'image', mimeType: 'image/png', data: SYNTHETIC_PNG.toString('base64') };
function service(client) {
  return new AcpAgentService({
    catId: 'codex',
    projectRoot: directory,
    mcpSupport: false,
    mcpServers: [],
    poolKey: { projectPath: directory, providerProfile: 'synthetic' },
    agentBusyRetryDelaysMs: [0],
    pool: {
      async acquire(poolKey) {
        return { client, poolKey, release() {} };
      },
      rememberSession() {},
    },
  });
}
const collect = async (iterator) => {
  const messages = [];
  for await (const message of iterator) messages.push(message);
  return messages;
};

for (const transport of ['stdio', 'httpstream']) {
  test(`#1598 ${transport}: callers cannot enable images by mutating initialize results`, async () => {
    const fixture = await imageFixture(transport, directory, { image: false });
    try {
      fixture.initialized.agentCapabilities.promptCapabilities.image = true;
      await assert.rejects(collect(fixture.client.promptStream('direct', [expectedImage])), {
        code: 'image_input_unsupported',
      });
      assert.equal(fixture.captured.filter((m) => m.method === 'session/prompt').length, 0);
    } finally {
      await fixture.close();
    }
  });
  test(`#1598 ${transport}: retries retain bytes even if the upload changes`, async () => {
    const filename = `changing-${transport}.png`;
    const path = join(directory, filename);
    await writeFile(path, SYNTHETIC_PNG);
    const fixture = await imageFixture(transport, directory, {
      busy: true,
      onPrompt() {
        writeFileSync(path, 'changed after admission');
      },
    });
    try {
      const messages = await collect(
        service(fixture.client).invoke('Describe.', {
          contentBlocks: [{ type: 'image', url: `/uploads/${filename}` }],
        }),
      );
      assert.equal(messages.filter((m) => m.type === 'error').length, 0);
      const prompts = fixture.captured.filter((m) => m.method === 'session/prompt');
      assert.equal(prompts.length, 2);
      for (const prompt of prompts)
        assert.deepEqual(
          prompt.params.prompt.filter((b) => b.type === 'image'),
          [expectedImage],
        );
    } finally {
      await fixture.close();
    }
  });
  for (const scenario of ['fresh', 'resume-empty', 'busy'])
    test(`#1598 ${transport} ${scenario}: image bytes survive each prompt attempt`, async () => {
      const fixture = await imageFixture(transport, directory, {
        resumeEmpty: scenario === 'resume-empty',
        busy: scenario === 'busy',
      });
      try {
        const messages = await collect(
          service(fixture.client).invoke('Describe this image.', {
            systemPrompt: 'PRIMARY-IDENTITY',
            resumeFallbackSystemPrompt: 'FALLBACK-IDENTITY',
            contentBlocks: images,
            ...(scenario === 'resume-empty' ? { sessionId: 'existing' } : {}),
          }),
        );
        assert.equal(messages.filter((m) => m.type === 'error').length, 0);
        const prompts = fixture.captured.filter((m) => m.method === 'session/prompt');
        assert.equal(prompts.length, scenario === 'fresh' ? 1 : 2);
        for (const prompt of prompts) {
          assert.match(prompt.params.prompt[0].text, /IDENTITY.*|Describe this image/s);
          assert.deepEqual(
            prompt.params.prompt.filter((b) => b.type === 'image'),
            [expectedImage],
          );
        }
      } finally {
        await fixture.close();
      }
    });

  for (const image of [false, null])
    test(`#1598 ${transport}: unannounced image capability ${image} blocks before prompt`, async () => {
      const fixture = await imageFixture(transport, directory, { image });
      try {
        const messages = await collect(service(fixture.client).invoke('Describe.', { contentBlocks: images }));
        assert.equal(messages.find((m) => m.type === 'error')?.errorCode, 'image_input_unsupported');
        assert.equal(fixture.captured.filter((m) => m.method === 'session/prompt').length, 0);
        assert.equal(fixture.captured.filter((m) => m.method === 'session/new').length, 0);
      } finally {
        await fixture.close();
      }
    });

  test(`#1598 ${transport}: unreadable second image rejects atomically`, async () => {
    const fixture = await imageFixture(transport, directory);
    try {
      const messages = await collect(
        service(fixture.client).invoke('Describe.', {
          contentBlocks: [...images, { type: 'image', url: '/uploads/missing.png' }],
        }),
      );
      assert.equal(messages.find((m) => m.type === 'error')?.errorCode, 'image_input_unavailable');
      assert.equal(fixture.captured.filter((m) => m.method === 'session/prompt').length, 0);
    } finally {
      await fixture.close();
    }
  });

  test(`#1598 ${transport}: direct block prompt has exact wire shape and string calls remain valid`, async () => {
    const fixture = await imageFixture(transport, directory);
    try {
      await collect(fixture.client.promptStream('direct', [{ type: 'text', text: 'Describe.' }, expectedImage]));
      await collect(fixture.client.promptStream('direct', 'text still works'));
      const prompts = fixture.captured.filter((m) => m.method === 'session/prompt');
      assert.deepEqual(prompts[0].params.prompt, [{ type: 'text', text: 'Describe.' }, expectedImage]);
      assert.deepEqual(prompts[1].params.prompt, [{ type: 'text', text: 'text still works' }]);
    } finally {
      await fixture.close();
    }
  });
}

test('#1598 stdio promptCollect preserves images and copies negotiated capability state', async () => {
  const fixture = await imageFixture('stdio', directory);
  try {
    fixture.client.promptCapabilities.image = false;
    await fixture.client.promptCollect('collected', [expectedImage]);
    assert.deepEqual(fixture.captured.find((m) => m.method === 'session/prompt').params.prompt, [expectedImage]);
  } finally {
    await fixture.close();
  }
});

for (const [url, code] of [
  ['/uploads/../outside.png', 'image_input_invalid'],
  ['/uploads/%2e%2e%2foutside.png', 'image_input_invalid'],
  ['https://example.invalid/image.png', 'image_input_invalid'],
  ['/uploads/unsupported.svg', 'image_input_invalid'],
  ['/uploads/empty.png', 'image_input_invalid'],
  ['/uploads/oversize.png', 'image_input_too_large'],
])
  test(`#1598 rejects invalid or oversized attachment: ${url}`, async () => {
    await writeFile(join(directory, 'empty.png'), '');
    await writeFile(join(directory, 'oversize.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    const fixture = await imageFixture('stdio', directory);
    try {
      const messages = await collect(
        service(fixture.client).invoke('Describe.', { contentBlocks: [{ type: 'image', url }] }),
      );
      assert.equal(messages.find((m) => m.type === 'error')?.errorCode, code);
      assert.equal(fixture.captured.filter((m) => m.method === 'session/prompt').length, 0);
    } finally {
      await fixture.close();
    }
  });

test('#1598 an upload symlink outside the upload owner is not dereferenced', async () => {
  const external = await mkdtemp(join(tmpdir(), 'acp-1598-external-'));
  await writeFile(join(external, 'private.png'), SYNTHETIC_PNG);
  // Directory junctions are unprivileged on Windows; symlinks exercise the same canonical containment elsewhere.
  await symlink(external, join(directory, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const fixture = await imageFixture('stdio', directory);
  try {
    const messages = await collect(
      service(fixture.client).invoke('Describe.', {
        contentBlocks: [{ type: 'image', url: '/uploads/external-link/private.png' }],
      }),
    );
    assert.equal(messages.find((m) => m.type === 'error')?.errorCode, 'image_input_invalid');
    assert.equal(fixture.captured.filter((m) => m.method === 'session/prompt').length, 0);
  } finally {
    await fixture.close();
  }
});

test('#1598 multiple images retain order and MIME, with count admission before dispatch', async () => {
  await writeFile(join(directory, 'second.JPEG'), Buffer.from([0xff, 0xd8, 0xff, 0x01]));
  const fixture = await imageFixture('stdio', directory);
  try {
    await collect(
      service(fixture.client).invoke('Describe.', {
        contentBlocks: [...images, { type: 'image', url: '/uploads/second.JPEG' }],
      }),
    );
    assert.deepEqual(fixture.captured.find((m) => m.method === 'session/prompt').params.prompt.slice(1), [
      expectedImage,
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64') },
    ]);
    const messages = await collect(
      service(fixture.client).invoke('Describe.', { contentBlocks: Array(6).fill(images[0]) }),
    );
    assert.equal(messages.find((m) => m.type === 'error')?.errorCode, 'image_input_too_large');
    assert.equal(fixture.captured.filter((m) => m.method === 'session/prompt').length, 1);
  } finally {
    await fixture.close();
  }
});
