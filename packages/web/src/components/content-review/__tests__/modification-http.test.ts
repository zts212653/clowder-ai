import { describe, expect, it } from 'vitest';
import { checked, ModificationHttpError, modificationFailureMessage } from '../modification-http';

const failed = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function failureOf(response: Response): Promise<ModificationHttpError> {
  try {
    await checked(response);
  } catch (error) {
    if (error instanceof ModificationHttpError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('checked reads the failure code the server sent', () => {
  it('reads a code nested as { error: { code } }, as the content review routes send it', async () => {
    const failure = await failureOf(failed(404, { error: { code: 'not_found' } }));

    expect(failure.code).toBe('not_found');
    expect(failure.status).toBe(404);
    expect(failure.message).toBe(modificationFailureMessage('not_found'));
    expect(failure.message).not.toBe(modificationFailureMessage('unknown'));
  });

  it('keeps reading a plain { error: code }', async () => {
    const failure = await failureOf(failed(403, { error: 'access_denied' }));

    expect(failure.code).toBe('access_denied');
    expect(failure.message).toBe('当前无法访问原作品；已停止展示其缓存内容。');
  });

  it('stays honest about an unreadable failure', async () => {
    const failure = await failureOf(new Response('upstream exploded', { status: 502 }));

    expect(failure.code).toBe('unknown');
    expect(failure.message).toBe('暂时无法确认操作结果。请保留原操作并重试。');
  });
});
