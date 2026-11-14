import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function sourceGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function sourceRef(root: string, name: string): Promise<string | null> {
  const rows = await sourceGit(root, ['for-each-ref', '--format=%(refname) %(objectname)', name]);
  return (
    rows
      .split('\n')
      .find((row) => row.startsWith(name + ' '))
      ?.slice(name.length + 1) ?? null
  );
}

export async function gitDocumentTree(root: string, revision: string): Promise<Map<string, string>> {
  const tree = await sourceGit(root, ['ls-tree', '-r', '-z', revision, '--', 'docs']);
  const files = new Map<string, string>();
  for (const entry of tree.split('\0')) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\tdocs\/(.+)$/u.exec(entry);
    if (match && /\.(md|svg)$/iu.test(match[3])) files.set(match[3], match[2]);
  }
  return files;
}

/** One bounded-lived Git reader per batch; never checkout, reset, or read dirty files. */
export async function* readGitBlobs(root: string, entries: Array<[string, string]>) {
  if (entries.length === 0) return;
  const child = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let failure: Error | undefined;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-1000);
  });
  child.on('error', (error) => {
    failure = error;
  });
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  const timer = setTimeout(() => {
    failure = new Error('Published source read timed out');
    child.kill('SIGKILL');
  }, 30_000);
  child.stdin.on('error', (error) => {
    failure = error;
  });
  child.stdin.end(entries.map(([, oid]) => oid).join('\n') + '\n');
  const parser = new GitBlobParser(entries);
  try {
    for await (const chunk of child.stdout) {
      for (const item of parser.push(chunk as Buffer)) yield item;
    }
    const code = await exited;
    if (failure || code !== 0 || parser.count !== entries.length) {
      throw failure ?? new Error(`Published source read incomplete: ${stderr}`);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
  }
}

class GitBlobParser {
  private buffer = Buffer.alloc(0);
  private size?: number;
  count = 0;
  constructor(private readonly entries: Array<[string, string]>) {}

  push(chunk: Buffer): Array<readonly [string, string]> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const result: Array<readonly [string, string]> = [];
    for (;;) {
      if (this.size === undefined && !this.header()) break;
      const size = this.size!;
      if (this.buffer.length < size + 1) break;
      result.push([this.entries[this.count++][0], this.buffer.subarray(0, size).toString('utf8')]);
      this.buffer = this.buffer.subarray(size + 1);
      this.size = undefined;
    }
    return result;
  }

  private header(): boolean {
    const newline = this.buffer.indexOf(10);
    if (newline < 0) return false;
    const match = /^([a-f0-9]+) blob (\d+)$/u.exec(this.buffer.subarray(0, newline).toString('utf8'));
    if (!match || match[1] !== this.entries[this.count]?.[1]) throw new Error('Published source blob is unavailable');
    this.size = Number(match[2]);
    if (this.size > 16 * 1024 * 1024) throw new Error('Published document exceeds 16 MiB read budget');
    this.buffer = this.buffer.subarray(newline + 1);
    return true;
  }
}
