export function observeOfficePage(page, apiOrigin, { errors, mutations, bridgeResponses, opened }) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', async (response) => {
    if (
      response.url().startsWith(apiOrigin) &&
      response.request().method() === 'POST' &&
      !response.url().includes('/editor-bridge')
    ) {
      const body = await response.json().catch(() => null);
      mutations.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        error: body?.error,
        code: body?.code,
      });
      if (new URL(response.url()).pathname === '/api/workspace/content-editor' && response.ok()) opened.push(body);
    }
    if (new URL(response.url()).pathname === '/api/collaborative-content/editor-bridge')
      bridgeResponses.push({ status: response.status(), body: await response.json().catch(() => null) });
  });
}
