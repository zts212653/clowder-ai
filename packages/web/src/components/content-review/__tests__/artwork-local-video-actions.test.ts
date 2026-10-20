import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { artworkFileActionUrl, artworkFileInfo } from '../artwork-file-client';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:5102',
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ local: false }), { status: 200 })),
}));

afterEach(() => vi.restoreAllMocks());
it.each([
  ['/uploads/local-video.mp4', '/api/uploads/local-video.mp4/file-info'],
  [
    '/api/workspace/file/raw?worktreeId=registered&path=clips%2Flocal.mp4',
    '/api/workspace/file/raw/file-info?worktreeId=registered&path=clips%2Flocal.mp4',
  ],
])('keeps the existing source coordinate for local video %s', (source, endpoint) => {
  expect(artworkFileActionUrl(source, 'file-info')).toBe(endpoint);
});
it('does not offer machine actions or request file paths in a narrow desktop browser', async () => {
  const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  const fetch = vi.mocked(apiFetch);
  fetch.mockClear();
  expect(await artworkFileInfo('/api/content-publications/content%3Avideo/media/1')).toEqual({ local: false });
  expect(fetch).not.toHaveBeenCalled();
  width.mockRestore();
});
it('does not reinterpret a remote media URL as a local file action', () => {
  expect(artworkFileActionUrl('https://remote.example/uploads/local.mp4', 'open')).toBeNull();
});
