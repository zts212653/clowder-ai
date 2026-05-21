import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  ANTIGRAVITY_IDE_READ_TOOL_NAMES,
  AntigravityIdeReadToolExecutor,
  filterAndTruncateRipgrepJsonForTest,
} from '../dist/domains/cats/services/agents/providers/antigravity/executors/IdeReadToolExecutor.js';

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function makeContext(cwd) {
  const entries = [];
  return {
    entries,
    ctx: {
      cascadeId: 'c1',
      trajectoryId: 't1',
      stepIndex: 4,
      cwd,
      audit: {
        record: async (entry) => {
          entries.push(entry);
        },
      },
    },
  };
}

describe('AntigravityIdeReadToolExecutor', () => {
  const cleanupDirs = [];

  afterEach(() => {
    for (const d of cleanupDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  function makeWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-ide-read-tools-'));
    cleanupDirs.push(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'const needle = true;\nconst other = false;\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    return root;
  }

  test('grep_search searches the workspace without shelling through arbitrary commands', async () => {
    const root = makeWorkspace();
    const executor = new AntigravityIdeReadToolExecutor('grep_search');
    const { ctx, entries } = makeContext(root);

    const result = await executor.execute({ Pattern: 'needle', Path: 'src' }, ctx);

    assert.equal(result.status, 'success');
    assert.match(result.stdout, /src\/index\.ts:1:const needle = true;/);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, 'grep_search');
    assert.equal(entries[0].result.status, 'success');
  });

  test('grep_search honors canonical SearchPath instead of defaulting to workspace root', async () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'docs needle\n');
    const executor = new AntigravityIdeReadToolExecutor('grep_search');
    const { ctx } = makeContext(root);

    const result = await executor.execute({ Pattern: 'needle', SearchPath: 'src' }, ctx);

    assert.equal(result.status, 'success');
    assert.match(result.stdout, /src\/index\.ts:1:const needle = true;/);
    assert.doesNotMatch(result.stdout, /docs\/notes\.md/);
  });

  test('list_dir honors canonical DirectoryPath instead of defaulting to workspace root', async () => {
    const root = makeWorkspace();
    const executor = new AntigravityIdeReadToolExecutor('list_dir');
    const { ctx } = makeContext(root);

    const result = await executor.execute({ DirectoryPath: 'src' }, ctx);

    assert.equal(result.status, 'success');
    assert.match(result.stdout, /\[file\]\s+index\.ts/);
    assert.doesNotMatch(result.stdout, /\[dir\]\s+src/);
  });

  test('grep_search keeps sensitive files filtered even when include asks for them', async () => {
    const root = makeWorkspace();
    const executor = new AntigravityIdeReadToolExecutor('grep_search');
    const { ctx } = makeContext(root);

    const result = await executor.execute({ Pattern: 'SECRET', Path: '.', Include: '.env' }, ctx);

    assert.equal(result.status, 'success');
    assert.equal(result.stdout, 'No matches found.');
  });

  test('grep_search honors canonical Includes filters from Antigravity payloads', async () => {
    const root = makeWorkspace();
    fs.writeFileSync(path.join(root, 'src', 'included.ts'), 'include needle\n');
    fs.writeFileSync(path.join(root, 'src', 'skipped.js'), 'include needle\n');
    const executor = new AntigravityIdeReadToolExecutor('grep_search');
    const { ctx } = makeContext(root);

    const result = await executor.execute({ Pattern: 'include needle', Path: 'src', Includes: ['*.ts'] }, ctx);

    assert.equal(result.status, 'success');
    assert.match(result.stdout, /src\/included\.ts:1:include needle/);
    assert.doesNotMatch(result.stdout, /src\/skipped\.js/);
  });

  test('grep_search ignores RIPGREP_CONFIG_PATH so external config cannot follow symlinks outside workspace', async () => {
    const root = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-ide-read-tools-outside-'));
    cleanupDirs.push(outside);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside needle\n');
    fs.symlinkSync(outside, path.join(root, 'src', 'linked-outside'), 'dir');
    const ripgrepConfigPath = path.join(root, 'rg.conf');
    fs.writeFileSync(ripgrepConfigPath, '--follow\n');
    const originalConfigPath = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = ripgrepConfigPath;

    try {
      const executor = new AntigravityIdeReadToolExecutor('grep_search');
      const { ctx } = makeContext(root);

      const result = await executor.execute({ Pattern: 'outside needle', Path: 'src' }, ctx);

      assert.equal(result.status, 'success');
      assert.equal(result.stdout, 'No matches found.');
    } finally {
      if (originalConfigPath === undefined) {
        delete process.env.RIPGREP_CONFIG_PATH;
      } else {
        process.env.RIPGREP_CONFIG_PATH = originalConfigPath;
      }
    }
  });

  test('grep_search preserves colon-bearing file paths when re-filtering results', async () => {
    const root = makeWorkspace();
    fs.writeFileSync(path.join(root, 'src', 'safe.pem:note.txt'), 'colon needle\n');
    const executor = new AntigravityIdeReadToolExecutor('grep_search');
    const { ctx } = makeContext(root);

    const result = await executor.execute({ Pattern: 'colon needle', Path: 'src' }, ctx);

    assert.equal(result.status, 'success');
    assert.match(result.stdout, /src\/safe\.pem:note\.txt:1:colon needle/);
  });

  test('grep_search decodes ripgrep json bytes fields before filtering results', () => {
    const stdout = [
      JSON.stringify({
        type: 'match',
        data: {
          path: { bytes: base64('src/bytes-name.txt') },
          lines: { bytes: base64('bytes needle\n') },
          line_number: 7,
        },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { bytes: base64('.env') },
          lines: { bytes: base64('SECRET=1\n') },
          line_number: 1,
        },
      }),
    ].join('\n');

    const output = filterAndTruncateRipgrepJsonForTest(stdout);

    assert.match(output, /src\/bytes-name\.txt:7:bytes needle/);
    assert.doesNotMatch(output, /SECRET=1/);
  });

  test('grep_search truncates broad results instead of failing on large ripgrep stdout', async () => {
    const root = makeWorkspace();
    const hugeLine = `needle ${'x'.repeat(7000)}`;
    fs.writeFileSync(
      path.join(root, 'src', 'huge.txt'),
      Array.from({ length: 100 }, (_, index) => `${hugeLine} ${index}`).join('\n'),
    );
    const executor = new AntigravityIdeReadToolExecutor('grep_search');
    const { ctx } = makeContext(root);

    const result = await executor.execute({ Pattern: 'needle', Path: 'src/huge.txt' }, ctx);

    assert.equal(result.status, 'success');
    assert.match(result.stdout, /src\/huge\.txt:1:needle/);
    assert.match(result.stdout, /\[Truncated: 50\//);
  });

  test('read_file and list_dir stay inside the workspace security boundary', async () => {
    const root = makeWorkspace();
    const { ctx } = makeContext(root);

    const read = await new AntigravityIdeReadToolExecutor('read_file').execute({ path: 'src/index.ts' }, ctx);
    assert.equal(read.status, 'success');
    assert.match(read.stdout, /const needle = true/);

    const listed = await new AntigravityIdeReadToolExecutor('list_dir').execute({ path: '.' }, ctx);
    assert.equal(listed.status, 'success');
    assert.match(listed.stdout, /\[dir\]\s+src/);
    assert.doesNotMatch(listed.stdout, /\.env/);

    const denied = await new AntigravityIdeReadToolExecutor('read_file').execute({ path: '.env' }, ctx);
    assert.equal(denied.status, 'error');
    assert.match(denied.error, /Access denied/i);
  });

  test('read_file rejects negative end_line instead of slicing from the file tail', async () => {
    const root = makeWorkspace();
    const { ctx } = makeContext(root);

    const result = await new AntigravityIdeReadToolExecutor('read_file').execute(
      { path: 'src/index.ts', start_line: 1, end_line: -1 },
      ctx,
    );

    assert.equal(result.status, 'error');
    assert.match(result.error, /end_line/i);
  });

  test('only the known read-only IDE tool names are registered by the executor family', () => {
    assert.deepEqual(ANTIGRAVITY_IDE_READ_TOOL_NAMES, ['grep_search', 'list_dir', 'read_file', 'view_file']);
  });
});
