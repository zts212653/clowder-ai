import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkCliFeishuSourceResolver } from '../../dist/domains/signal-intake/index.js';

describe('F292 Host-owned lark-cli transcript resolver', () => {
  it('uses argv-only minute detail and returns bounded transcript content', async () => {
    const calls = [];
    const resolver = new LarkCliFeishuSourceResolver({
      makeTempDirectory: async () => '/tmp/f292-test',
      readText: async () => 'Minute transcript',
      removeTempDirectory: async () => {},
      run: async (args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ data: { transcript_file: '/tmp/f292-test/transcript.txt' } }), stderr: '' };
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
    assert.deepEqual(calls[0], [
      'minutes',
      '+detail',
      '--minute-tokens',
      'om_abc123',
      '--transcript',
      '--output-dir',
      '/tmp/f292-test',
      '--format',
      'json',
      '--as',
      'user',
    ]);
  });

  it('selects unified note transcript and rejects non-canonical handles before CLI access', async () => {
    const calls = [];
    const resolver = new LarkCliFeishuSourceResolver({
      makeTempDirectory: async () => '/tmp/f292-test',
      readText: async () => 'Note transcript',
      removeTempDirectory: async () => {},
      run: async (args) => {
        calls.push(args);
        if (args[1] === '+detail') {
          return { stdout: JSON.stringify({ data: { note_display_type: 'unified' } }), stderr: '' };
        }
        return { stdout: JSON.stringify({ data: { transcript_file: '/tmp/f292-test/note.txt' } }), stderr: '' };
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
    assert.deepEqual(calls[1], [
      'note',
      '+transcript',
      '--note-id',
      'note_abc',
      '--transcript-format',
      'plain_text',
      '--output',
      '/tmp/f292-test/note.txt',
      '--format',
      'json',
      '--as',
      'user',
    ]);
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
