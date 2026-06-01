import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveImageUploadMetadata } from '../dist/domains/weixin-mp/weixin-mp-client.js';

describe('WeixinMpClient image upload metadata', () => {
  it('uses fetched JPEG content-type instead of URL suffix guesses', () => {
    assert.deepEqual(deriveImageUploadMetadata('image/jpeg; charset=binary'), {
      mimeType: 'image/jpeg',
      fileName: 'image.jpg',
    });
  });

  it('uses fetched GIF content-type for extensionless signed URLs', () => {
    assert.deepEqual(deriveImageUploadMetadata('image/gif'), {
      mimeType: 'image/gif',
      fileName: 'image.gif',
    });
  });
});
