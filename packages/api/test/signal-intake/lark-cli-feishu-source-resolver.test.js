import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkCliFeishuSourceResolver } from '../../dist/domains/signal-intake/index.js';

describe('F292 Host-owned lark-cli transcript resolver', () => {
  it('uses argv-only minute detail and returns bounded transcript content', async () => {
    const calls = [];
    const reads = [];
    const resolver = new LarkCliFeishuSourceResolver({
      makeTempDirectory: async () => '/tmp/f292-test',
      readText: async (path) => {
        reads.push(path);
        return 'Minute transcript';
      },
      removeTempDirectory: async () => {},
      run: async (args, _signal, cwd) => {
        calls.push({ args, cwd });
        return {
          stdout: JSON.stringify({
            data: {
              minutes: [
                {
                  minute_token: 'om_foreign',
                  artifacts: { transcript_file: 'foreign/transcript.txt' },
                },
                {
                  minute_token: 'om_abc123',
                  artifacts: { transcript_file: 'artifact/transcript.txt' },
                },
              ],
            },
          }),
          stderr: '',
        };
      },
    });
    const result = await resolver.resolve(
      {
        sourceHandle: 'feishu://meeting-artifacts/minute/om_abc123?revision=7',
        intakeId: 'intake-1',
        sourceGrant: 'opaque',
      },
      new AbortController().signal,
    );
    assert.equal(result.text, 'Minute transcript');
    assert.deepEqual(reads, ['/tmp/f292-test/artifact/transcript.txt']);
    assert.deepEqual(calls[0], {
      args: [
        'minutes',
        '+detail',
        '--minute-tokens',
        'om_abc123',
        '--transcript',
        '--output-dir',
        '.',
        '--format',
        'json',
        '--as',
        'user',
      ],
      cwd: '/tmp/f292-test',
    });
  });

  it('selects unified note transcript and rejects non-canonical handles before CLI access', async () => {
    const calls = [];
    const resolver = new LarkCliFeishuSourceResolver({
      makeTempDirectory: async () => '/tmp/f292-test',
      readText: async () => 'Note transcript',
      removeTempDirectory: async () => {},
      run: async (args, _signal, cwd) => {
        calls.push({ args, cwd });
        if (args[1] === '+detail') {
          return { stdout: JSON.stringify({ data: { note_display_type: 'unified' } }), stderr: '' };
        }
        return { stdout: JSON.stringify({ data: { transcript_file: 'note.txt' } }), stderr: '' };
      },
    });
    const result = await resolver.resolve(
      {
        sourceHandle: 'feishu://meeting-artifacts/note/note_abc?revision=latest',
        intakeId: 'intake-1',
        sourceGrant: 'opaque',
      },
      new AbortController().signal,
    );
    assert.equal(result.text, 'Note transcript');
    assert.deepEqual(calls[1], {
      args: [
        'note',
        '+transcript',
        '--note-id',
        'note_abc',
        '--transcript-format',
        'plain_text',
        '--output',
        './note.txt',
        '--format',
        'json',
        '--as',
        'user',
      ],
      cwd: '/tmp/f292-test',
    });
    await assert.rejects(
      resolver.resolve(
        {
          sourceHandle: 'feishu://meeting-artifacts:8443/note/note_abc?revision=latest',
          intakeId: 'intake-1',
          sourceGrant: 'opaque',
        },
        new AbortController().signal,
      ),
      /canonical/,
    );
    assert.equal(calls.length, 2);
  });

  it('does not misclassify a validation failure as auth merely because argv contains minute-tokens', async () => {
    const resolver = new LarkCliFeishuSourceResolver({
      makeTempDirectory: async () => '/tmp/f292-test',
      removeTempDirectory: async () => {},
      run: async () => {
        throw Object.assign(new Error('Command failed: lark-cli minutes +detail --minute-tokens om_abc123'), {
          stderr: 'validation: --output must be a relative path within the current directory',
          stdout: '',
        });
      },
    });

    await assert.rejects(
      resolver.resolve(
        {
          sourceHandle: 'feishu://meeting-artifacts/minute/om_abc123?revision=7',
          intakeId: 'intake-1',
          sourceGrant: 'opaque',
        },
        new AbortController().signal,
      ),
      (error) => error.code === 'EXECUTION_FAILED',
    );
  });

  it('maps authentication diagnostics from stderr without inspecting argv text', async () => {
    const resolver = new LarkCliFeishuSourceResolver({
      makeTempDirectory: async () => '/tmp/f292-test',
      removeTempDirectory: async () => {},
      run: async () => {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'Access token expired; please login again.',
          stdout: '',
        });
      },
    });

    await assert.rejects(
      resolver.resolve(
        {
          sourceHandle: 'feishu://meeting-artifacts/minute/om_abc123?revision=7',
          intakeId: 'intake-1',
          sourceGrant: 'opaque',
        },
        new AbortController().signal,
      ),
      (error) => error.code === 'SOURCE_AUTH_REQUIRED',
    );
  });

  it('rejects transcript paths that lexically escape the Host temp directory', async () => {
    let readCalled = false;
    const resolver = new LarkCliFeishuSourceResolver({
      makeTempDirectory: async () => '/tmp/f292-test',
      readText: async () => {
        readCalled = true;
        return 'secret';
      },
      removeTempDirectory: async () => {},
      run: async () => ({
        stdout: JSON.stringify({ data: { transcript_file: '/tmp/f292-test/../outside.txt' } }),
        stderr: '',
      }),
    });
    await assert.rejects(
      resolver.resolve(
        {
          sourceHandle: 'feishu://meeting-artifacts/minute/om_abc123?revision=7',
          intakeId: 'intake-1',
          sourceGrant: 'opaque',
        },
        new AbortController().signal,
      ),
      (error) => error.code === 'EXECUTION_FAILED' && /unsafe transcript path/.test(error.message),
    );
    assert.equal(readCalled, false);
  });
});
