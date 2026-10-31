import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Positive native scenarios own this fake login. The caller restores both test selectors afterward. */
export function selectFakeCodexHome(projectRoot) {
  const home = join(projectRoot, '.codex');
  mkdirSync(home, { recursive: true });
  const claims = {
    'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-workspace' },
  };
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`,
        account_id: 'fixture-workspace',
      },
    }),
  );
  process.env.CODEX_HOME = home;
  process.env.CODEX_SQLITE_HOME = home;
}
