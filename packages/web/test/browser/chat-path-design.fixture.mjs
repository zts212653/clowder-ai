import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../..', import.meta.url));
const report = 'docs/discussions/2026-10-23-department-weekly-report/README.md';
const cover = 'docs/evidence/2026-09-29-workspace-home-northstar/art/cafe-landing-A.png';
const actions = 'F317-actions.md';
/** The exact accepted sample prose, in the real message store; files and Git objects are real. */
export async function seedChatPathDesignSample({ app, root, owner, threads, messages, language }) {
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { maxBuffer: 16 * 1024 * 1024 });
  const sourceHead = git('rev-parse', 'origin/main').toString().trim();
  const designDirectory = path.join(repository, 'docs/evidence/2026-10-22-chat-path-chips');
  app.get('/api/chat-path-design/proposal', async (_request, reply) => {
    const html = (await readFile(path.join(designDirectory, 'proposal.html'), 'utf8'))
      .replaceAll('src="av-opus55.jpg"', 'src="/api/chat-path-design/av-opus55.jpg"')
      .replaceAll('src="sample-landing.png"', 'src="/api/chat-path-design/sample-landing.png"');
    return reply.type('text/html; charset=utf-8').send(html);
  });
  for (const [filename, type] of [
    ['av-opus55.jpg', 'image/jpeg'],
    ['sample-landing.png', 'image/png'],
  ])
    app.get(`/api/chat-path-design/${filename}`, async (_request, reply) =>
      reply.type(type).send(await readFile(path.join(designDirectory, filename))),
    );
  for (const filename of [report, cover]) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), git('show', `${sourceHead}:${filename}`));
  }
  // The draft named this future note. A controlled real file makes its :42 link verifiable.
  await writeFile(
    path.join(root, actions),
    '# F317 actions\n' + '\n'.repeat(39) + '## Actions\nVerified sample at line 42.\n',
  );
  const commit = git('rev-parse', '881135a8f8^{commit}').toString().trim();
  // A local read-only object alternate avoids repacking the whole evidence history for each sample.
  const objects = path.resolve(repository, git('rev-parse', '--git-path', 'objects').toString().trim());
  await writeFile(path.join(root, '.git/objects/info/alternates'), objects + '\n');
  if (execFileSync('git', ['-C', root, 'cat-file', '-t', commit], { encoding: 'utf8' }).trim() !== 'commit')
    throw new Error('The design commit must exist');
  const code = (value) => '`' + value + '`';
  const content =
    language === 'en'
      ? `Thank you for liking the draft. I have organized the full 30-minute report into three parts: inner source, open source, and frontier capabilities (F311 / F317 / F290).\n\nPushed (${code('881135a8f8')}); the remote content matches what I wrote.\n\nThe full 30-minute report is ready on main. Its cover is ${code(cover)}, and the structure follows ${code(actions + ':42')}.\n\nFull report:\n\n${code(report)}\n\nA PR for your review:\n\nhttps://github.com/zts212653/clowder-ai/pull/5961`
      : `谢谢你喜欢那份稿子。这次按 30 分钟把整场汇报梳理成一份完整稿，分三大块：内源、开源、前沿能力（F311 / F317 / F290 等）。\n\n已经推上去了（${code('881135a8f8')}），远端内容和我写的逐字一致。\n\n30 分钟的完整汇报稿写好了，已经推到 main，封面用的是 ${code(cover)}，讲稿结构参照了 ${code(actions + ':42')}。\n\n完整稿：\n\n${code(report)}\n\n提了一个 PR 等你看：\n\nhttps://github.com/zts212653/clowder-ai/pull/5961`;
  const thread = threads.create(owner, language === 'en' ? 'Accepted path design sample' : '路径标签原稿对照', root);
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
  return { thread, message, imageMessage, longMessage, sourceHead, commit, report, cover, actions };
}
