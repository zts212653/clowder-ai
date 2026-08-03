import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourcePaths = [
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatReaderModels.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatReaderCore.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatLayoutGuard.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatNavigationModels.swift', import.meta.url)),
  fileURLToPath(
    new URL('../src/plugins/wechat-visible-reader/native/WeChatConversationNavigator.swift', import.meta.url),
  ),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatNavigationFixtures.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatVisibleReader.swift', import.meta.url)),
];
const macOsFixtureOptions = {
  timeout: 60_000,
  skip: process.platform !== 'darwin' && 'requires macOS xcrun/Swift toolchain',
};

describe('WeChat conversation navigation fixtures', () => {
  it('passes fail-closed navigation, stitching, restore, and layout fixtures', macOsFixtureOptions, () => {
    const directory = mkdtempSync(join(tmpdir(), 'f265-navigation-fixtures-'));
    const executable = join(directory, 'wechat-reader-fixture');
    try {
      const compile = spawnSync('/usr/bin/xcrun', ['swiftc', ...sourcePaths, '-o', executable], {
        encoding: 'utf8',
        timeout: 45_000,
      });
      assert.equal(compile.status, 0, compile.stderr);

      const run = spawnSync(executable, ['--navigation-self-test'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), {
        ok: true,
        tests: [
          'search_not_ready_no_input',
          'unique_exact_result_only',
          'ambiguous_exact_result_refused',
          'header_mismatch_refused',
          'three_page_overlap_ordered',
          'duplicate_body_preserved',
          'unrelated_repeated_sequence_not_false_overlap',
          'failure_restores_all_scene_parts',
          'cooperative_termination_cancellation',
          'dpr_light_dark_relative_layout_guard',
          'offscreen_stale_windows_ignored',
        ],
      });
      assert.deepEqual(readdirSync(directory), ['wechat-reader-fixture']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
