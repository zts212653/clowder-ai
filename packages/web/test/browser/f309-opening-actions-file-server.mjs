import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Real file-action routes, not a fabricated `local:true` response. The review
 * owner remains a controlled fixture; its file action targets this same asset. */
export async function createOpeningFileServer({ repo, image, filePath, worktreeIds }) {
  const api = path.join(repo, 'packages/api');
  const require = createRequire(path.join(api, 'package.json'));
  const app = require('fastify')();
  const { registerWorkspaceMediaFileActions } = await import(
    pathToFileURL(path.join(api, 'dist/routes/local-media-file-actions.js'))
  );
  const { registerWorktrees } = await import(
    pathToFileURL(path.join(api, 'dist/domains/workspace/workspace-security.js'))
  );
  assert.ok(image.endsWith(filePath));
  const root = image.slice(0, -filePath.length);
  assert.equal(path.resolve(root, filePath), path.resolve(image));
  registerWorktrees(worktreeIds.map((id) => ({ id, root, head: 'fixture', branch: 'fixture' })));
  registerWorkspaceMediaFileActions(app);
  return {
    close: () => app.close(),
    async inject(url, method) {
      const action = url.pathname.split('/').at(-1);
      const executed = url.pathname.startsWith('/api/workspace/file/raw/')
        ? `${url.pathname}${url.search}`
        : `/api/workspace/file/raw/${action}?${new URLSearchParams({ worktreeId: worktreeIds[0], path: filePath })}`;
      const response = await app.inject({
        method,
        url: executed,
        // Test local-Human fixture only. Full session/CSRF and review authority
        // are verified separately in the actual named Alpha.
        headers: { host: 'localhost', 'x-cat-cafe-user': 'operator' },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      return { response, executed };
    },
  };
}
