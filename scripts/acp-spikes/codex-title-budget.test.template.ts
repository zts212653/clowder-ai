import { afterEach, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '../CodexAppServerClient';
import { TitleGenerator } from '../TitleGenerator';

const saved = process.env.CLOWDER_SPIKE_DISABLE_AUTO_TITLE;
afterEach(() => {
  if (saved === undefined) delete process.env.CLOWDER_SPIKE_DISABLE_AUTO_TITLE;
  else process.env.CLOWDER_SPIKE_DISABLE_AUTO_TITLE = saved;
});
for (const disabled of [false, true]) {
  it(`W4.P native title budget flag disabled=${disabled}`, async () => {
    if (disabled) process.env.CLOWDER_SPIKE_DISABLE_AUTO_TITLE = '1';
    else delete process.env.CLOWDER_SPIKE_DISABLE_AUTO_TITLE;
    const threadStart = vi.fn(async () => {
      throw new Error('Fake native call; no model service');
    });
    const title = new TitleGenerator(
      { threadStart } as unknown as CodexAppServerClient,
      'test',
      '/synthetic',
      () => 'unset',
    );
    title.onTurnCompleted('synthetic prompt');
    await title.waitForIdle(100);
    expect(threadStart).toHaveBeenCalledTimes(disabled ? 0 : 1);
  });
}
