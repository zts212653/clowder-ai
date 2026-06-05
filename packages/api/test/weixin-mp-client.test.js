import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { deriveImageUploadMetadata, WeixinMpClient } from '../dist/domains/weixin-mp/weixin-mp-client.js';

const originalFetch = globalThis.fetch;

describe('WeixinMpClient image upload metadata', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it('invalidates a cached token and retries draft creation once on WeChat auth errors', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return { json: async () => ({ errcode: 40001, errmsg: 'invalid access_token' }) };
      }
      return { json: async () => ({ errcode: 0, media_id: 'draft-media-id' }) };
    };

    let tokenCalls = 0;
    let invalidateCalls = 0;
    const tokenManager = {
      getAccessToken: async () => {
        tokenCalls += 1;
        return tokenCalls === 1 ? 'cached-token' : 'fresh-token';
      },
      invalidateAccessToken: async () => {
        invalidateCalls += 1;
      },
    };
    const client = new WeixinMpClient(tokenManager);

    const mediaId = await client.createDraft([
      {
        title: 'Draft',
        content: '<p>Draft</p>',
        thumb_media_id: 'thumb-media-id',
        show_cover_pic: 1,
      },
    ]);

    assert.equal(mediaId, 'draft-media-id');
    assert.equal(invalidateCalls, 1);
    assert.equal(tokenCalls, 2);
    assert.match(urls[0], /access_token=cached-token/);
    assert.match(urls[1], /access_token=fresh-token/);
  });
});
