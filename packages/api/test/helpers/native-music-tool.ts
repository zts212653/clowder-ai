import { spawn } from 'node:child_process';

export async function nativeTool(
  command: string,
  args: string[],
  env: Record<string, string>,
  input: unknown,
  options: { timeoutMs?: number; onSpawn?: (pid: number) => void; signal?: AbortSignal } = {},
) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let exited = false;
  let timedOut = false;
  let aborted = false;
  let processError: Error | undefined;
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      processError = error;
    });
    child.once('close', (code) => {
      exited = true;
      resolve(code);
    });
  });
  const terminate = () => {
    if (!exited) child.kill('SIGKILL');
  };
  const abort = () => {
    aborted = true;
    terminate();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs ?? 20_000);
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.resume();
  child.stdin.on('error', (error) => {
    processError = error;
    terminate();
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  let output: string;
  try {
    if (child.pid) options.onSpawn?.(child.pid);
    if (options.signal?.aborted) abort();
    else
      child.stdin.end(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_music', arguments: input } })}\n`,
      );
    const code = await closed;
    if (timedOut) throw new Error('native_fixture_timeout');
    if (aborted) throw new Error('native_fixture_aborted');
    if (processError) throw processError;
    if (code !== 0) throw new Error('native_fixture_exit');
    output = Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    terminate();
    await closed;
  }
  const response = JSON.parse(output.trim());
  if (response.result.isError) throw new Error('native_fixture_refused');
  return JSON.parse(response.result.content[0].text) as { state: string };
}
