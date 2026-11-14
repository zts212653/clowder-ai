import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

/**
 * Local HTTP server on an ephemeral port. A long keep-alive makes any connection a
 * fetcher forgets to release outlive the test budget instead of closing by itself.
 */
export async function startLocalHttpServer(handler, { keepAliveTimeoutMs = 120_000 } = {}) {
  const server = createServer(handler);
  server.keepAliveTimeout = keepAliveTimeoutMs;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * Runs `new <exportName>().fetch(source)` from a built fetcher module in a fresh Node
 * process, the way the one-shot fetch-signals CLI does. A request left open keeps that
 * process alive, so "exited on its own within the budget" is the property under test.
 */
export async function fetchInChildProcess({ moduleUrl, exportName, source, budgetMs = 10_000 }) {
  const script = [
    `const mod = await import(${JSON.stringify(moduleUrl)});`,
    `const result = await new mod[${JSON.stringify(exportName)}]().fetch(${JSON.stringify(source)});`,
    'process.stdout.write(JSON.stringify({ articles: result.articles.length, errors: result.errors }));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const startedAt = Date.now();
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exitedOnItsOwn: false, code: null });
    }, budgetMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitedOnItsOwn: true, code });
    });
  });

  return {
    ...exit,
    elapsedMs: Date.now() - startedAt,
    stderr,
    // The fetch may finish and print its result even when the process then fails to exit.
    result: stdout ? JSON.parse(stdout) : undefined,
  };
}
