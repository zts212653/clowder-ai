import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { publicCollectiveAvatar } from '../dist/domains/plugin/builtin-runtime/collective-public-avatar.js';

test('registered local avatar becomes a small portable image, while traversal is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collective-avatar-'));
  try {
    const avatars = join(root, 'avatars');
    await mkdir(avatars);
    await writeFile(
      join(avatars, 'sol.png'),
      await sharp({ create: { width: 400, height: 400, channels: 4, background: '#665544' } })
        .png()
        .toBuffer(),
    );
    const image = await publicCollectiveAvatar('/avatars/sol.png', { avatars, uploads: root });
    assert.match(image, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
    assert.ok(image.length < 1_200);
    assert.equal(await publicCollectiveAvatar('/avatars/../private.png', { avatars, uploads: root }), undefined);
    assert.equal(
      await publicCollectiveAvatar('http://127.0.0.1:3011/avatars/sol.png', { avatars, uploads: root }),
      undefined,
    );
    await writeFile(join(root, 'secret.png'), 'not an avatar');
    await symlink(join(root, 'secret.png'), join(avatars, 'link.png'));
    assert.equal(await publicCollectiveAvatar('/avatars/link.png', { avatars, uploads: root }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
