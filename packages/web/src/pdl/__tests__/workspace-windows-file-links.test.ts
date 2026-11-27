// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('chat retains the Windows file target and decodes its href exactly once', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), 'public/pdl', path), 'utf8');
  const escapeHtml = read('engine/core.js')
    .split('\n')
    .find((line) => line.startsWith('function h('));
  const markdown = new Function(
    'const MD_REF = {};\n' +
      escapeHtml +
      '\n' +
      read('library/markdown.js').split('function annotationHtml')[0] +
      '\nreturn mdInline;',
  )();
  const host = document.createElement('div');
  host.innerHTML = markdown(
    '[architecture](/G:/AIwork/docs/agent-access-architecture.html) ' +
      '[encoded](/G:/AIwork/My%20File%2520%26%22.html) ' +
      '[native](<G:/AIwork/My File.html>) [relative](docs/My%20File.md) ' +
      '[external](https://example.com/My%20File.md)',
  );
  expect(
    Array.from(host.querySelectorAll<HTMLButtonElement>('button[data-act="fileOpen"]'), (link) => link.dataset.v),
  ).toEqual([
    '/G:/AIwork/docs/agent-access-architecture.html',
    '/G:/AIwork/My File%20&".html',
    '/G:/AIwork/My File.html',
    'docs/My File.md',
  ]);
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/My%20File.md');
});

test('one workspace file model keeps the same local actions through HTML, source and Office tabs', () => {
  const scripts = readFileSync(resolve(process.cwd(), 'public/pdl-app/workbench-data.js'), 'utf8');
  const root = { ws: { fileMode: 'render' } };
  const file = { path: 'design/My File%20.html', content: '<h1>Document</h1>', binary: false, mime: 'text/html' };
  const snapshot = {
    opened: { worktreeId: 'tree', file },
    workspace: { worktrees: [{ id: 'tree' }] },
    fileEdits: {},
    editing: {},
    fileInfo: {
      scope: JSON.stringify(['tree', file.path]),
      info: {
        local: true,
        canOpen: true,
        canOpenWith: true,
        canReveal: true,
        desktopPlatform: 'win32',
        defaultApplication: 'Chrome',
        noDefaultApplication: false,
        path: 'G:\\design\\My File%20.html',
      },
    },
  };
  const model = new Function('projectData', 'S', 'api', scripts + '\nreturn workbenchModels();')(() => snapshot, root, {
    file: (path: string) => path,
  });
  const expected = '/workspace-html?worktreeId=tree&path=design%2FMy+File%2520.html';
  expect(model.filePage).toMatchObject({
    documentFrame: expected,
    htmlPreview: true,
    mode: 'render',
    copyPath: snapshot.fileInfo.info.path,
    actions: {
      canOpen: true,
      openAction: 'open',
      openLabel: { t: 'workbench.file.openLocalWithName', args: ['Chrome'] },
      revealLabel: { t: 'workbench.file.revealWindows' },
    },
  });
  root.ws.fileMode = 'src';
  snapshot.fileInfo.info.noDefaultApplication = true;
  expect(model.filePage).toMatchObject({
    documentFrame: null,
    htmlPreview: false,
    mode: 'src',
    actions: { canOpen: true, openAction: 'open-with', noDefaultApplication: true },
  });
  expect(model.filePage.body).toBe('<h1>Document</h1>');
  file.path = 'pdf notes.pdf';
  file.binary = true;
  file.mime = 'application/pdf';
  snapshot.fileInfo.scope = JSON.stringify(['tree', file.path]);
  expect(model.filePage).toMatchObject({
    documentFrame: '/workspace-document?worktreeId=tree&path=pdf+notes.pdf',
    actions: { canOpen: true, openAction: 'open-with' },
  });
});
