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
  ['/uploads/construction-map.png', '/api/uploads/construction-map.png/file-info'],
  [
    '/api/workspace/file/raw?worktreeId=registered&path=clips%2Flocal.mp4',
    '/api/workspace/file/raw/file-info?worktreeId=registered&path=clips%2Flocal.mp4',
  ],
])('keeps the existing source coordinate for local media %s', (source, endpoint) => {
  expect(artworkFileActionUrl(source, 'file-info')).toBe(endpoint);
});
it.each([390, 1440])('uses the same authoritative local file facts at a %spx reading width', async (pixels) => {
  const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(pixels);
  const fetch = vi.mocked(apiFetch);
  fetch.mockClear();
  const facts = { local: true, path: '/original/local-video.mp4', canReveal: true };
  fetch.mockResolvedValueOnce(Response.json(facts));
  expect(await artworkFileInfo('/api/content-publications/content%3Avideo/media/1')).toEqual(facts);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/content-publications/content%3Avideo/media/1/file-info');
  width.mockRestore();
});
it('does not reinterpret a remote media URL as a local file action', () => {
  expect(artworkFileActionUrl('https://remote.example/uploads/local.mp4', 'open')).toBeNull();
});
