import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import sharp from 'sharp';
import { createDeskAvatarReader } from '../src/domains/concierge/live/host/companion-desk-avatar.js';

test('F335 desk avatar: a registered cat’s /avatars/ file shrinks to a 40px PNG; anything else is null', async () => {
  const catId = catRegistry
    .getAllIds()
    .find((id) => String(catRegistry.tryGet(id)?.config.avatar ?? '').startsWith('/avatars/'));
  assert.ok(catId, 'the test registry has a cat with an /avatars/ avatar');
  const dir = await mkdtemp(join(tmpdir(), 'desk-avatar-'));
  const source = join(dir, 'source.png');
  await writeFile(
    source,
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#b05f45' } })
      .png()
      .toBuffer(),
  );
  const asked: string[] = [];
  const read = createDeskAvatarReader((url) => {
    asked.push(url);
    return source;
  });
  const image = await read(catId);
  assert.equal(image?.mediaType, 'image/png');
  assert.equal(image?.width, 40);
  const meta = await sharp(Buffer.from(image?.dataBase64 ?? '', 'base64')).metadata();
  assert.deepEqual([meta.width, meta.height], [40, 40]);
  assert.deepEqual(asked, [catRegistry.tryGet(catId)?.config.avatar]);
  assert.equal(await read('no-such-cat'), null);
  assert.equal(await createDeskAvatarReader(() => undefined)(catId), null, 'unresolvable path');
  assert.equal(await createDeskAvatarReader(() => join(dir, 'missing.png'))(catId), null, 'missing file');
});
