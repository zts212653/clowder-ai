import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Controlled fake official attempts: cancellation and late results remain observable without real OAuth. */
export function createFixtureLoginDriver() {
  const pending = [];
  return {
    driver: {
      run(input) {
        input.onReady();
        return new Promise((resolve, reject) => {
          const item = { input, resolve, reject, keepPendingAfterAbort: false };
          input.signal.addEventListener(
            'abort',
            () => {
              if (!item.keepPendingAfterAbort) reject(new Error('fixture_canceled'));
            },
            { once: true },
          );
          pending.push(item);
        });
      },
    },
    close() {
      for (const item of pending) item.reject(new Error('fixture_closed'));
    },
    captureLoginAttempt() {
      const index = pending.length - 1;
      const item = pending[index];
      if (!item) throw new Error('No official login attempt has started');
      return {
        keepPendingAfterAbort() {
          item.keepPendingAfterAbort = true;
        },
        wasAborted() {
          return item.input.signal.aborted;
        },
        async complete(override) {
          const identity = override ?? {
            userId: `user-${index}`,
            workspaceId: `workspace-${index}`,
            email: `account${index}@example.test`,
          };
          mkdirSync(item.input.home, { recursive: true });
          const jwt = `x.${Buffer.from(JSON.stringify({ email: identity.email, 'https://api.openai.com/auth': { chatgpt_user_id: identity.userId, chatgpt_account_id: identity.workspaceId } })).toString('base64url')}.x`;
          writeFileSync(
            join(item.input.home, 'auth.json'),
            JSON.stringify({
              tokens: { id_token: jwt, account_id: identity.workspaceId, access_token: 'fixture-access' },
            }),
          );
          item.resolve(identity);
          return identity;
        },
      };
    },
  };
}
