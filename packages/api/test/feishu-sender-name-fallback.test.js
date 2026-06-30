/**
 * FeishuAdapter.resolveSenderNameFromChat — fallback name resolution
 * via chat members API when Contact API fails (error 41050).
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { FeishuAdapter } = await import('../dist/infrastructure/connectors/im-connectors/feishu/FeishuAdapter.js');

function makeAdapter() {
  const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
  const adapter = new FeishuAdapter('app-id', 'app-secret', log);
  return { adapter, log };
}

describe('FeishuAdapter.resolveSenderNameFromChat', () => {
  it('resolves sender name from chat members API', async () => {
    const { adapter } = makeAdapter();

    // Inject tokenManager and fetchFn
    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          items: [
            { member_id: 'ou_sender1', name: 'You' },
            { member_id: 'ou_sender2', name: 'Mom' },
            { member_id: 'ou_sender3', name: 'Dad' },
          ],
        },
      }),
    }));

    const name = await adapter.resolveSenderNameFromChat('ou_sender2', 'oc_chat123');
    assert.equal(name, 'Mom');
  });

  it('caches ALL members from single API call', async () => {
    const { adapter } = makeAdapter();

    const fetchFn = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          items: [
            { member_id: 'ou_a', name: 'Alice' },
            { member_id: 'ou_b', name: 'Bob' },
          ],
        },
      }),
    }));
    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = fetchFn;

    // First call — hits API
    const name1 = await adapter.resolveSenderNameFromChat('ou_a', 'oc_chat');
    assert.equal(name1, 'Alice');
    assert.equal(fetchFn.mock.calls.length, 1);

    // Second call for different member — should use cache, no new API call
    const name2 = await adapter.resolveSenderNameFromChat('ou_b', 'oc_chat');
    assert.equal(name2, 'Bob');
    assert.equal(fetchFn.mock.calls.length, 1, 'should reuse cache from first call');
  });

  it('returns undefined when member not found', async () => {
    const { adapter } = makeAdapter();

    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { items: [{ member_id: 'ou_other', name: 'Other' }] },
      }),
    }));

    const name = await adapter.resolveSenderNameFromChat('ou_missing', 'oc_chat');
    assert.equal(name, undefined);
  });

  it('returns undefined on API error', async () => {
    const { adapter, log } = makeAdapter();

    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = mock.fn(async () => ({
      ok: false,
      status: 403,
    }));

    const name = await adapter.resolveSenderNameFromChat('ou_x', 'oc_chat');
    assert.equal(name, undefined);
    assert.ok(log.warn.mock.calls.length > 0, 'should log warning');
  });

  it('paginates through multiple pages to find target member', async () => {
    const { adapter } = makeAdapter();

    let callCount = 0;
    const fetchFn = mock.fn(async (url) => {
      callCount++;
      const urlObj = new URL(url);
      const pageToken = urlObj.searchParams.get('page_token');

      if (!pageToken) {
        // Page 1: members 1-3, has_more=true
        return {
          ok: true,
          json: async () => ({
            data: {
              items: [
                { member_id: 'ou_page1_a', name: 'Alice' },
                { member_id: 'ou_page1_b', name: 'Bob' },
                { member_id: 'ou_page1_c', name: 'Carol' },
              ],
              has_more: true,
              page_token: 'token_page2',
            },
          }),
        };
      } else if (pageToken === 'token_page2') {
        // Page 2: members 4-5, target is here
        return {
          ok: true,
          json: async () => ({
            data: {
              items: [
                { member_id: 'ou_page2_a', name: 'Dave' },
                { member_id: 'ou_target', name: 'TargetUser' },
              ],
              has_more: false,
            },
          }),
        };
      }
      return { ok: false, status: 500 };
    });

    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = fetchFn;

    const name = await adapter.resolveSenderNameFromChat('ou_target', 'oc_chat');
    assert.equal(name, 'TargetUser');
    assert.equal(fetchFn.mock.calls.length, 2, 'should have fetched 2 pages');
  });

  it('stops paginating early when target found on first page', async () => {
    const { adapter } = makeAdapter();

    const fetchFn = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          items: [
            { member_id: 'ou_early', name: 'EarlyFind' },
            { member_id: 'ou_other', name: 'Other' },
          ],
          has_more: true,
          page_token: 'token_page2',
        },
      }),
    }));

    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = fetchFn;

    const name = await adapter.resolveSenderNameFromChat('ou_early', 'oc_chat');
    assert.equal(name, 'EarlyFind');
    assert.equal(fetchFn.mock.calls.length, 1, 'should NOT fetch page 2 — target already found');
  });

  it('returns undefined after exhausting all pages without finding target', async () => {
    const { adapter } = makeAdapter();

    let callCount = 0;
    const fetchFn = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            data: {
              items: [{ member_id: 'ou_not_target', name: 'NotTarget' }],
              has_more: true,
              page_token: 'token_page2',
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            items: [{ member_id: 'ou_also_not', name: 'AlsoNot' }],
            has_more: false,
          },
        }),
      };
    });

    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = fetchFn;

    const name = await adapter.resolveSenderNameFromChat('ou_missing_everywhere', 'oc_chat');
    assert.equal(name, undefined);
    assert.equal(fetchFn.mock.calls.length, 2, 'should have fetched all pages');
  });

  it('shares cache with resolveSenderName', async () => {
    const { adapter } = makeAdapter();

    // Pre-populate via resolveSenderName path (simulate Contact API success)
    adapter.tokenManager = { getTenantAccessToken: async () => 'test-token' };
    adapter.uploadFetchFn = mock.fn(async () => ({
      ok: true,
      json: async () => ({ data: { user: { name: 'ContactName' } } }),
    }));

    await adapter.resolveSenderName('ou_cached');

    // Now resolveSenderNameFromChat should find it in cache — no API call
    const fetchFn2 = mock.fn(async () => ({ ok: false, status: 500 }));
    adapter.uploadFetchFn = fetchFn2;

    const name = await adapter.resolveSenderNameFromChat('ou_cached', 'oc_chat');
    assert.equal(name, 'ContactName');
    assert.equal(fetchFn2.mock.calls.length, 0, 'should not call API — cache hit');
  });
});
