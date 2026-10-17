import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { membersCopy } from '../members.shell-copy';

interface NamingEntry {
  n: number;
  key: string;
  zh_draft: string;
  zh: string;
  en: string;
}
const dispositionPath = resolve(
  __dirname,
  '../../../../../../docs/evidence/2026-10-03-f322-v2-members/naming-disposition.json',
);

it.skipIf(!existsSync(dispositionPath))(
  'consumes every resolved static Chinese and English naming target (private naming evidence)',
  () => {
    const disposition = JSON.parse(readFileSync(dispositionPath, 'utf8')) as { entries: NamingEntry[] };
    expect(disposition.entries).toHaveLength(211);
    for (const entry of disposition.entries.filter((item) => item.n !== 3 && !item.zh_draft.includes('=>'))) {
      for (const language of ['zh', 'en'] as const) {
        expect((membersCopy[language] as Record<string, unknown>)[entry.key], `${entry.n}:${language}`).toBe(
          entry[language],
        );
      }
    }
  },
);
it('uses the approved mention name term and keeps names verbatim', () => {
  expect(membersCopy.en['@ 名字']).toBe('Mention names');
  expect(membersCopy.en.aliasTaken('@somebody')).toBe('Mention name “@somebody” is already used by another member');
  expect(membersCopy.zh.砚砚('真实名字')).toBe('真实名字');
  expect(membersCopy.en.砚砚('真实名字')).toBe('真实名字');
});
it('keeps complete parameterized account and required-field sentences', () => {
  expect(membersCopy.en.accountLabel('Provider A', 'api_key')).toBe('Provider A · API key account');
  expect(membersCopy.zh.accountLabel('Provider A', 'api_key')).toBe('Provider A · API 密钥账号');
  expect(membersCopy.en.requiredFields(['Account'])).toBe('1 more field needed to add: Account.');
  expect(membersCopy.en.requiredFields(['Account', 'Model'])).toBe('2 more fields needed to add: Account, Model.');
});
it('uses both accepted strategy-specific action hints', () => {
  expect(membersCopy.zh.hybridActionHint).toBe(
    '执行状态为“可用”时，达到此比例：压缩次数未满就由客户端决定是否压缩，满了就交接到新会话。',
  );
  expect(membersCopy.en.hybridActionHint).toBe(
    'When this strategy is available: at this level, the client may compress until the limit is reached; after that, the session hands off.',
  );
});
it('keeps the actual CLI and URL in the localized complete sentence', () => {
  expect(membersCopy.en.cliActualCall('claude', 'https://test.example/v1/messages')).toBe(
    'claude CLI request: https://test.example/v1/messages',
  );
});
