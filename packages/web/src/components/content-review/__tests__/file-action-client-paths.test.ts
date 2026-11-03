import { afterEach, expect, it, vi } from 'vitest';
import { contentFileInfo } from '../file-action-client';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://file.test', apiFetch: transport.fetch }));
const source = { kind: 'workspace' as const, worktreeId: 'tree', path: 'docs/report.md' };
afterEach(() => vi.resetAllMocks());

it.each([
  '/home/user/project/report.md',
  'C:\\demo\\project with spaces\\报告.md',
  'D:/project/report.md',
  '\\\\server\\share\\project\\report.md',
])('accepts the authorized absolute file path %s without changing its identity', async (path) => {
  const facts = { local: true, path, filename: 'report.md', canOpen: false, canReveal: false };
  transport.fetch.mockResolvedValue(Response.json(facts));
  await expect(contentFileInfo(source)).resolves.toEqual(facts);
});

it.each([
  'docs/report.md',
  'C:report.md',
  '\\report.md',
  '',
  null,
  42,
])('rejects a local response without a fully qualified path: %s', async (path) => {
  transport.fetch.mockResolvedValue(Response.json({ local: true, path }));
  await expect(contentFileInfo(source)).rejects.toThrow('invalid_file_info');
});

it('retains remote file information without requiring a local path', async () => {
  transport.fetch.mockResolvedValue(Response.json({ local: false }));
  await expect(contentFileInfo(source)).resolves.toEqual({ local: false });
});
