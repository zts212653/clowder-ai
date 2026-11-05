import { afterEach, expect, it, vi } from 'vitest';
import {
  downloadContentFile,
  fileActionUrl,
  fileDownloadUrl,
  fileSourceIdentity,
} from '../../content-review/file-action-client';

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => fixture.fetch(...args),
}));
afterEach(() => vi.restoreAllMocks());
it('the shared download keeps an external native link without a CORS fetch, and authenticates same-site reads', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.href).toBe('https://files.example.org/report.pdf');
  });
  fixture.fetch.mockReset();
  await downloadContentFile('https://files.example.org/report.pdf', '原件.pdf');
  expect(click).toHaveBeenCalledTimes(1);
  expect(fixture.fetch).not.toHaveBeenCalled();
  fixture.fetch.mockResolvedValue({ ok: false });
  await expect(downloadContentFile('http://api.test/uploads/report.pdf', '原件.pdf')).rejects.toThrow();
  expect(fixture.fetch).toHaveBeenCalledWith('/uploads/report.pdf');
});
it('Unicode basenames are local candidates; encoded separators and traversal cannot become file-action paths', () => {
  const name = 'doc-0a6831f6718f-Clowder_AI_后续建设与分工讨论稿-v0_2.md';
  expect(fileActionUrl({ kind: 'url', url: '/uploads/' + encodeURIComponent(name) }, 'file-info')).toBe(
    '/api/uploads/' + encodeURIComponent(name) + '/file-info',
  );
  for (const name of ['a%2Fb.md', 'a%5Cb.md', 'a%00b.md', '%2e%2e', 'a%2F..%2Fsecrets'])
    expect(fileActionUrl({ kind: 'url', url: '/uploads/' + name }, 'open')).toBeNull();
});

it('raw and download representations keep one locator and the common download uses the attachment byte route', async () => {
  const query = new URLSearchParams({ worktreeId: 'root', path: '中文稿.md' });
  const raw = 'http://api.test/api/workspace/file/raw?' + query;
  const download = 'http://api.test/api/workspace/file/download?' + query;
  expect(fileDownloadUrl(raw)).toBe(download);
  expect(fileSourceIdentity({ kind: 'url', url: raw })).toBe(fileSourceIdentity({ kind: 'url', url: download }));
  expect(fileActionUrl({ kind: 'url', url: download }, 'file-info')).toBe('/api/workspace/file/raw/file-info?' + query);
  expect(fileDownloadUrl('https://external.test/api/workspace/file/raw?' + query)).toBe(
    'https://external.test/api/workspace/file/raw?' + query,
  );
});
