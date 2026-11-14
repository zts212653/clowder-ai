import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PublishedDocumentSource } from '../../dist/domains/memory/PublishedDocumentSource.js';
import { FileTasteRepository } from '../../dist/domains/taste/services/TasteRepository.js';
import { createRemoteFixture, git } from '../taste-publication-fixtures.js';

export const owner = 'cue-published-owner';
export const sha = (text) => createHash('sha256').update(text).digest('hex');
export const documentRevision = (path, content) => `sha256:${sha(`${path}\0${content}`)}`;
export const vignette = (scene, privacy = 'public') =>
  `---\nstatus: approved\nwhen: "reviewing a system"\nquotes: ["Synthetic owner evidence"]\nscene: "${scene}"\ntags: [review]\ndimension: cognitive-honesty\nprivacy: ${privacy}\n---\n`;

export function publishedCueFixture(t, files) {
  const f = createRemoteFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(f.primary, path)), { recursive: true });
    writeFileSync(join(f.primary, path), content);
  }
  git(f.primary, ['add', '--', ...Object.keys(files)]);
  git(f.primary, ['commit', '-m', 'publish cue fixture sources']);
  git(f.primary, ['push', 'origin', 'main']);
  return {
    ...f,
    repository: new FileTasteRepository(f.runtime),
    publishedSource: new PublishedDocumentSource(f.runtime),
    publish(path, content) {
      if (content === null) git(f.primary, ['rm', '-f', '--', path]);
      else {
        mkdirSync(dirname(join(f.primary, path)), { recursive: true });
        writeFileSync(join(f.primary, path), content);
        git(f.primary, ['add', '--', path]);
      }
      git(f.primary, ['commit', '-m', 'revise cue fixture source']);
      git(f.primary, ['push', 'origin', 'main']);
    },
  };
}
