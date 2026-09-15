import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');

const projectRoot = '/home/user/cat-cafe';
const ordinaryWorktree = '/home/user/cat-cafe-f306-media-read-export-guard';
const runtimeRoot = '/home/user/cat-cafe-runtime';
const source = `${runtimeRoot}/scripts/meeting-copilot/transcripts/thread_mtol26dken2gip0y/recording-unknown-1-primary.mp3`;
const destination = '/tmp/f195-recording-primary.mp3';

function decide(command, cwd = projectRoot) {
  return decideNativeHookPayload({
    turn_id: 'turn-f306-media-export',
    tool_name: 'Bash',
    cwd,
    tool_input: { command },
  });
}

describe('F306 runtime media read and export guard contract', () => {
  test('allows only the exact local ffprobe metadata and SHA-256 read shapes', () => {
    const metadata = decide(`ffprobe -v error -show_entries format=duration,size -of json ${source}`);
    assert.equal(metadata.effect, 'read');
    assert.equal(metadata.target.kind, 'runtime_sanctuary');
    assert.equal(metadata.decision, 'allow');
    assert.equal(metadata.reasonCode, 'read_only');

    for (const path of [source, destination]) {
      const digest = decide(`shasum -a 256 ${path}`);
      assert.equal(digest.effect, 'read', path);
      assert.equal(digest.target.kind, path === source ? 'runtime_sanctuary' : 'ordinary', path);
      assert.equal(digest.decision, 'allow', path);
      assert.equal(digest.reasonCode, 'read_only', path);
    }
  });

  test('attributes one explicit single-file copy to its absolute destination', () => {
    const exported = decide(`cp -- ${source} ${destination}`);

    assert.equal(exported.effect, 'write');
    assert.equal(exported.target.kind, 'ordinary');
    assert.equal(exported.target.value, destination);
    assert.equal(exported.reasonCode, 'ordinary_policy_deferred');
    assert.equal(exported.decision, 'allow');
  });

  test('keeps unbounded ffprobe and digest variants fail-closed against protected targets', () => {
    for (const command of [
      `ffprobe -v error -show_entries format=duration,size -of json -o /tmp/probe.json ${source}`,
      `ffprobe -hide_banner -v error -show_entries format=duration,size -of json ${source}`,
      'ffprobe -v error -show_entries format=duration,size -of json https://example.com/recording.mp3',
      `ffprobe -v error -show_entries format=duration,size -of json ${source} | jq .`,
      `ffprobe -v error -show_entries format=duration,size -of json ${source}; echo done`,
      `ffprobe -v error -show_entries format=duration,size -of json "$(printf %s ${source})"`,
      `ffprobe -v error -show_entries format=duration,size -of json ${source} > /tmp/probe.json`,
      '/usr/bin/ffprobe -v error -show_entries format=duration,size -of json https://example.com/recording.mp3',
      'env ffprobe -v error -show_entries format=duration,size -of json https://example.com/recording.mp3',
      `shasum -a 1 ${source}`,
      'command shasum -a 256 /tmp/f195-recording-primary.mp3',
      `shasum -a 256 ${source} | cut -d ' ' -f 1`,
      `shasum -a 256 ${source} > /tmp/source.sha256`,
      `ffmpeg -i ${source} /tmp/transcoded.mp3`,
    ]) {
      const verdict = decide(command, command.includes(runtimeRoot) ? projectRoot : runtimeRoot);
      assert.equal(verdict.decision, 'deny', command);
    }
  });

  test('defers unbounded media commands on ordinary targets to existing policy', () => {
    for (const command of [
      'shasum -a 256 dist/bundle.js',
      'shasum -a 256 ./package.json',
      'shasum -a 256 /tmp/a /tmp/b',
      'shasum -a 1 /tmp/x',
      'shasum /tmp/x',
      'shasum -a 256 /tmp/x | tee /tmp/h',
      'ffprobe -h',
      'ffprobe -version',
      'echo hi && shasum -a 256 /tmp/x',
    ]) {
      const verdict = decide(command, ordinaryWorktree);
      assert.equal(verdict.target.kind, 'ordinary', command);
      assert.equal(verdict.decision, 'allow', command);
    }

    for (const command of ['shasum -a 256 dist/bundle.js', 'ffprobe -version']) {
      const verdict = decide(command, runtimeRoot);
      assert.equal(verdict.target.kind, 'runtime_sanctuary', command);
      assert.equal(verdict.decision, 'deny', command);
      assert.equal(verdict.reasonCode, 'unbounded_local_media_observation', command);
    }
  });

  test('keeps ambiguous or protected copy destinations fail-closed', () => {
    for (const command of [
      `cp ${source} ${destination}`,
      `cp -- ${source} relative-copy.mp3`,
      `cp -- ${source} /tmp/first.mp3 /tmp/second.mp3`,
      `cp -R -- ${source} ${destination}`,
      `cp -f -- ${source} ${destination}`,
      `cp -- ${source} ${runtimeRoot}/copy.mp3`,
      `cp -- relative-source.mp3 ${destination}`,
      `cp -- ${source} ${destination}; echo copied`,
      `cp -- ${source} "$(printf %s ${destination})"`,
      `cp -- ${runtimeRoot}/scripts/meeting-copilot/transcripts/* ${destination}`,
      `cp -- ${source} /tmp/../cat-cafe-runtime/copy.mp3`,
    ]) {
      const cwd = command.includes('relative-source.mp3') ? runtimeRoot : projectRoot;
      const verdict = decide(command, cwd);
      assert.equal(verdict.decision, 'deny', command);
    }
  });
});
