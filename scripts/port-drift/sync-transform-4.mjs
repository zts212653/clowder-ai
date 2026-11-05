import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { it } from 'node:test';
import {
  assertPortableClaudeHookTemplate,
  ROOT,
  readClaudeHookTemplateCommands,
  readSyncScript,
  readYamlTopLevelList,
} from './context.mjs';

export function registerSyncTransformPart4() {
  it('sync-manifest excludes internal raw L0 staging content from public skill refs', () => {
    const excluded = readYamlTopLevelList('sync-manifest.yaml', 'excluded');
    const stagingContent = 'cat-cafe-skills/refs/l0-staging-content.md';

    assert.ok(existsSync(resolve(ROOT, stagingContent)), `${stagingContent} must still exist in the source repo`);
    assert.ok(
      excluded.includes(stagingContent),
      'ADR-038 raw L0 staging content contains internal routing/thread context and must not be exported as a public skill ref',
    );

    const stagingContentSource = readFileSync(
      resolve(ROOT, 'packages/api/src/domains/cats/services/context/StagingContent.ts'),
      'utf-8',
    );
    assert.match(
      stagingContentSource,
      /code === 'ENOENT'[\s\S]*EMPTY_STAGING_CONTENT/,
      'public export may omit raw L0 staging content, so API must tolerate ENOENT with an empty staging manifest',
    );

    const invokeSingleCatTest = readFileSync(resolve(ROOT, 'packages/api/test/invoke-single-cat.test.js'), 'utf-8');
    assert.match(
      invokeSingleCatTest,
      /hasSourceStagingContent/,
      'invoke-single-cat ADR-038 tests must distinguish source repo staging from public export without raw L0 staging content',
    );
    assert.match(
      invokeSingleCatTest,
      /assertStagingPromptContract/,
      'invoke-single-cat ADR-038 prompt assertions must keep source strict while allowing public export to omit raw staging strings',
    );
  });

  it('public governance hash helper rebases drift guard to sanitized shared-rules headings', () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-public-governance-hash-'));
    try {
      const sharedRulesPath = resolve(tempRoot, 'cat-cafe-skills/refs/shared-rules.md');
      const testFilePath = resolve(tempRoot, 'packages/api/test/system-prompt-builder.test.js');
      const helperDir = resolve(tempRoot, 'helper path with spaces');
      const helperPath = resolve(helperDir, 'update-public-governance-hash.mjs');
      mkdirSync(dirname(sharedRulesPath), { recursive: true });
      mkdirSync(dirname(testFilePath), { recursive: true });
      mkdirSync(helperDir, { recursive: true });
      copyFileSync(resolve(ROOT, 'scripts/update-public-governance-hash.mjs'), helperPath);

      const publicSharedRules = [
        '### P1. 面向终态，不绕路',
        '### W3. 用户是 operator，不是甲方路由器',
        '### W8. 共享视图——人猫共创家园，产物天然该在共享工作空间里可见',
        '',
      ].join('\n');
      writeFileSync(sharedRulesPath, publicSharedRules);
      writeFileSync(testFilePath, "const PINNED_HASH = '89989b48ac64c6ee';\n");

      execFileSync('node', [helperPath, sharedRulesPath, testFilePath]);

      const expectedHash = createHash('sha256')
        .update(
          publicSharedRules
            .split('\n')
            .filter((line) => /^###?\s+(P\d|W\d)/.test(line))
            .sort()
            .join('\n'),
        )
        .digest('hex')
        .slice(0, 16);
      const updatedTest = readFileSync(testFilePath, 'utf-8');
      assert.match(updatedTest, new RegExp(`const PINNED_HASH = '${expectedHash}';`));
      assert.doesNotMatch(updatedTest, /89989b48ac64c6ee/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('sync-to-opensource.sh rebases public governance hash after comprehensive sanitization', () => {
    const content = readSyncScript();

    assert.match(
      content,
      /scripts\/update-public-governance-hash\.mjs/,
      'sync should call the public governance hash helper after sanitizer changes shared-rules.md',
    );
    assert.match(
      content,
      /cat-cafe-skills\/refs\/shared-rules\.md[\s\S]*packages\/api\/test\/system-prompt-builder\.test\.js/,
      'sync should derive the public PINNED_HASH from the exported shared-rules.md and patch the exported test',
    );
  });

  it('sync-manifest exports the public governance hash helper used by public env-port checks', () => {
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');

    assert.ok(
      managedScripts.includes('scripts/check-env-port-drift.test.mjs'),
      'public check:env-ports exports check-env-port-drift.test.mjs',
    );
    assert.ok(
      managedScripts.includes('scripts/update-public-governance-hash.mjs'),
      'check-env-port-drift.test.mjs copies the governance hash helper and needs it in public checkouts',
    );
  });

  it('sync-to-opensource.sh hard-fails if public L0 still contains internal patterns', () => {
    const content = readSyncScript();

    assert.match(
      content,
      /l0_internal_found=\$\(printf '%s\\n' "\$found" \| grep -F 'assets\/system-prompts\/system-prompt-l0\.md'/,
      'internal-pattern scan should isolate system-prompt-l0.md findings',
    );
    assert.match(
      content,
      /l0_internal_found[\s\S]*?SCAN_FAILED=true/,
      'system-prompt-l0.md internal-pattern findings should fail the sync gate, not warn only',
    );
  });

  it('sync-to-opensource.sh allows story redaction regex literals in the security scan', () => {
    const content = readSyncScript();

    assert.match(
      content,
      /\/domains\/story\/content-sanitizer\\\.ts\$/,
      'story export redaction module carries secret-shaped regex literals and must be treated like other secret scanners',
    );
  });

  it('sync-manifest exports a portable F180 Claude settings hook template', () => {
    const managedFiles = readYamlTopLevelList('sync-manifest.yaml', 'managed_files');
    const templatePath = '.claude/hooks/user-level/claude-settings.template.json';

    assert.ok(
      managedFiles.includes(templatePath),
      `sync-manifest should export ${templatePath} as the Claude settings hook template`,
    );

    const template = readFileSync(resolve(ROOT, templatePath), 'utf-8');
    assertPortableClaudeHookTemplate(template);
    assert.doesNotThrow(() => JSON.parse(template));

    const commands = readClaudeHookTemplateCommands(template);
    assert.deepEqual(commands, [
      'bash "$HOME/.claude/hooks/session-start-recall.sh"',
      'bash "$HOME/.claude/hooks/session-stop-check.sh"',
    ]);
  });

  it('F180 Claude settings hook template guard rejects maintainer absolute-path variants', () => {
    const absolutePathTemplates = [
      '{"hooks":{"SessionStart":[{"hooks":[{"command":"/home/alice/.claude/hooks/session-start-recall.sh"}]}]}}',
      '{"hooks":{"SessionStart":[{"hooks":[{"command":"C:/home/user/.claude/hooks/session-start-recall.sh"}]}]}}',
      '{"hooks":{"SessionStart":[{"hooks":[{"command":"C:\\\\Users\\\\Alice\\\\.claude\\\\hooks\\\\session-start-recall.sh"}]}]}}',
      '{"hooks":{"SessionStart":[{"hooks":[{"command":"bash \\"/home/alice/.claude/hooks/session-start-recall.sh\\""}]}]}}',
    ];

    for (const template of absolutePathTemplates) {
      assert.throws(() => assertPortableClaudeHookTemplate(template));
    }
  });

  it('source install/setup attempts F180 agent hook sync as a nonfatal step', () => {
    const install = readFileSync(resolve(ROOT, 'scripts/install.sh'), 'utf-8');
    const setup = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');

    for (const [name, content] of [
      ['install.sh', install],
      ['setup.sh', setup],
    ]) {
      assert.match(content, /sync_agent_hooks_best_effort\(\)/, `${name} should call the shared hook sync step`);
      assert.match(
        content,
        /pnpm exec tsx scripts\/sync-system-prompts\.ts --apply --agent-hooks-only/,
        `${name} should reuse sync-system-prompts hook targets without syncing non-hook prompts`,
      );
      assert.match(
        content,
        /Agent CLI hook sync failed[\s\S]*continuing/,
        `${name} should warn and continue when hook sync fails`,
      );
    }
  });

  it('F210 source installer provisions Antigravity CLI through native bootstrapper', () => {
    const install = readFileSync(resolve(ROOT, 'scripts/install.sh'), 'utf-8');
    const installPs = readFileSync(resolve(ROOT, 'scripts/install.ps1'), 'utf-8');

    assert.match(install, /install_antigravity_cli\(\)/);
    assert.match(install, /https:\/\/antigravity\.google\/cli\/install\.sh/);
    assert.match(install, /MISSING_AGENTS\+=\("agy"\)/);
    assert.match(install, /agy\)\s+install_antigravity_cli/s);
    assert.doesNotMatch(install, /install_npm_cli "Gemini CLI" "gemini" "@google\/gemini-cli"/);

    assert.match(installPs, /Name = "Antigravity"; Label = "Antigravity CLI"; Cmd = "agy"/);
    assert.match(installPs, /InstallKind = "antigravity-native"/);
    assert.match(installPs, /https:\/\/antigravity\.google\/cli\/install\.cmd/);
    assert.match(installPs, /Resolve-ToolCommandWithRetry -Name "agy" -Attempts 6/);
    assert.doesNotMatch(installPs, /Name = "Gemini"; Label = "Gemini"; Cmd = "gemini"; Pkg = "@google\/gemini-cli"/);
  });

  it('sync-system-prompts agent hook mode also configures Claude settings', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/sync-system-prompts.ts'), 'utf-8');

    assert.match(
      content,
      /syncClaudeSettings/,
      'agent hook sync CLI should reuse the same Claude settings merge helper as the Hub sync API',
    );
    assert.match(
      content,
      /if\s*\(\s*isAgentHooksOnly\s*&&\s*!isDryRun\s*\)[\s\S]*await syncClaudeSettings\(syncTargetRoot\)/,
      '--agent-hooks-only --apply must configure Claude settings, not only copy hook scripts and Codex hooks',
    );
  });

  it('desktop installer bundles F180 hook truth source and offline sync helper', () => {
    const inno = readFileSync(resolve(ROOT, 'desktop/installer/cat-cafe.iss'), 'utf-8');
    const desktopPackage = readFileSync(resolve(ROOT, 'desktop/package.json'), 'utf-8');

    assert.match(
      inno,
      /Source: "\.\.\\\.\.\\\.claude\\hooks\\user-level\\\*";\s+DestDir: "\{app\}\\\.claude\\hooks\\user-level"/,
      'Windows installer should ship the user-level hook truth source',
    );
    assert.match(
      inno,
      /Source: "\.\.\\scripts\\sync-agent-hooks-offline\.mjs";\s+DestDir: "\{app\}\\scripts"/,
      'Windows installer should ship the offline hook sync helper',
    );
    assert.match(
      desktopPackage,
      /"from": "\.\.\/\.claude\/hooks\/user-level"[\s\S]*"to": "\.claude\/hooks\/user-level"/,
      'macOS DMG resources should ship the user-level hook truth source',
    );
    assert.match(
      desktopPackage,
      /"from": "\.\/scripts\/sync-agent-hooks-offline\.mjs"[\s\S]*"to": "scripts\/sync-agent-hooks-offline\.mjs"/,
      'macOS DMG resources should ship the offline hook sync helper',
    );
  });
}
