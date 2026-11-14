import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const referenceHtml = fileURLToPath(new URL('./fixtures/chat-path-reference.html', import.meta.url));
const report = 'docs/path-reference/report.md';
const cover = 'images/sol.png';
const actions = 'docs/path-reference/actions.md';

/** Controlled specimens, not the historical private draft. Every file and commit belongs to this fixture repo. */
export async function seedChatPathDesignSample({ app, root, owner, threads, messages, language }) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  await mkdir(path.dirname(path.join(root, report)), { recursive: true });
  await writeFile(
    path.join(root, report),
    '# Controlled path reference report\n\nThis portable test document is not the historical weekly report.\n',
  );
  await writeFile(
    path.join(root, actions),
    ['# Controlled actions', ...Array(40).fill(''), 'Controlled action at line 42.', ''].join('\n'),
  );
  git('add', '--', report, actions);
  git('commit', '-qm', 'Add controlled path reference specimens');
  const commit = git('rev-parse', 'HEAD');
  if (git('cat-file', '-t', commit) !== 'commit') throw new Error('Controlled commit is missing');
  app.get('/api/chat-path-design/proposal', async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send((await readFile(referenceHtml, 'utf8')).replaceAll('CONTROLLED_SHA', commit.slice(0, 10))),
  );
  app.get('/api/chat-path-design/cover.png', async (_request, reply) =>
    reply.type('image/png').send(await readFile(path.join(root, cover))),
  );
  const code = (value) => '`' + value + '`';
  const content =
    language === 'en'
      ? `Controlled path reference specimen: these files and this Git commit are created only for this test.\n\nLocal commit (${code(commit.slice(0, 10))}).\n\nThe controlled report uses ${code(cover)} and ${code(actions + ':42')}.\n\nControlled report:\n\n${code(report)}\n\nA PR reference:\n\nhttps://github.com/controlled-fixture/path-reference-workspace/pull/5961`
      : `受控路径对照样例：文件和 Git 提交均由本测试自建，不是历史私有原稿。\n\n本地提交（${code(commit.slice(0, 10))}）。\n\n受控报告用到 ${code(cover)}，动作位于 ${code(actions + ':42')}。\n\n受控报告：\n\n${code(report)}\n\n一条 PR 引用：\n\nhttps://github.com/controlled-fixture/path-reference-workspace/pull/5961`;
  const thread = threads.create(owner, language === 'en' ? 'Controlled path reference' : '受控路径对照', root);
  const message = messages.append({
    userId: owner,
    threadId: thread.id,
    from: { kind: 'agent', catId: 'codex61-sol' },
    content,
    timestamp: Date.now(),
  });
  const imageMessage = messages.append({
    userId: owner,
    threadId: thread.id,
    from: { kind: 'agent', catId: 'codex61-sol' },
    content: code(cover),
    timestamp: Date.now(),
  });
  const longFilename = 'long-file-name-'.repeat(8) + '.md';
  await writeFile(path.join(root, longFilename), '# Long file punctuation specimen\n');
  const longMessage = messages.append({
    userId: owner,
    threadId: thread.id,
    from: { kind: 'agent', catId: 'codex61-sol' },
    content: `（${code(longFilename)}）。`,
    timestamp: Date.now(),
  });
  return {
    thread,
    message,
    imageMessage,
    longMessage,
    sourceHead: commit,
    commit,
    report,
    cover,
    actions,
    sampleKind: 'controlled-path-reference-v1',
  };
}
