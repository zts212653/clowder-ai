import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';

describe('prompt-injection review guard scripts', () => {
  const firstAvailableCatId = () => {
    const catalogPath = existsSync('.cat-cafe/cat-catalog.json') ? '.cat-cafe/cat-catalog.json' : 'cat-template.json';
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const entry = Object.entries(catalog.roster ?? {}).find(([catId, rosterEntry]) => {
      return catId !== 'owner' && rosterEntry && rosterEntry.available !== false;
    });
    assert.ok(entry, `${catalogPath} must contain at least one available non-owner cat`);
    return entry[0];
  };

  const availableCatIdExcluding = (excludedCatId) => {
    const catalogPath = existsSync('.cat-cafe/cat-catalog.json') ? '.cat-cafe/cat-catalog.json' : 'cat-template.json';
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const entry = Object.entries(catalog.roster ?? {}).find(([catId, rosterEntry]) => {
      return catId !== 'owner' && catId !== excludedCatId && rosterEntry && rosterEntry.available !== false;
    });
    return entry?.[0] ?? null;
  };

  it('durable prompt-injection files do not keep the old F226 feature anchor', () => {
    const reviewNotes = spawnSync('git', ['ls-files', 'review-notes'], {
      encoding: 'utf-8',
    })
      .stdout.split('\n')
      .filter((path) => path.includes('injection') || path.includes('cleanup'));
    const files = [
      'assets/prompt-injection-manifest.yaml',
      'packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts',
      'packages/api/src/domains/cats/services/context/prompt-template-loader.ts',
      'packages/api/src/routes/prompt-injection-hooks.ts',
      'packages/api/src/routes/prompt-injection-preview.ts',
      'packages/api/src/routes/prompt-injection.ts',
      'packages/api/src/routes/rules.ts',
      'packages/api/test/l0-compiler.test.js',
      'packages/web/src/components/settings/CatDimensionSelector.tsx',
      'packages/web/src/components/settings/CompiledPreviewModal.tsx',
      'packages/web/src/components/settings/InjectionManifestContent.tsx',
      'packages/web/src/components/settings/LifecycleFlowDiagram.tsx',
      'packages/web/src/components/settings/RulesPromptsParts.tsx',
      'packages/web/src/components/settings/SegmentEditorModal.tsx',
      'packages/web/src/components/settings/StageDetailPanels.tsx',
      'packages/web/src/components/settings/lifecycle-stages.ts',
      'scripts/check-manifest-drift.mjs',
      'scripts/verify-template-extraction.mjs',
      ...reviewNotes,
    ];

    const pathOffenders = files.filter((path) => /f226/i.test(path));
    assert.deepEqual(pathOffenders, [], 'prompt-injection review artifact paths must not anchor to F226');

    const contentOffenders = files.filter((path) => readFileSync(path, 'utf-8').includes('F226'));
    assert.deepEqual(contentOffenders, [], 'prompt-injection source/docs must use F237 or omit feature anchors');
  });

  it('verify-template-extraction discloses exact byte-identity coverage', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-template-extraction.mjs'], {
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Byte-identical compatibility coverage:\s*4 templates/i);
    assert.match(result.stdout, /Additional extracted templates are not byte-compared/i);
  });

  it('check-manifest-drift enforces loader local overlay and manifest flags in both directions', () => {
    const source = readFileSync('scripts/check-manifest-drift.mjs', 'utf-8');
    assert.match(
      source,
      /extractTemplateFileInfo|TEMPLATE_LOADER_PATH/,
      'drift check should inspect loader template local registry',
    );
    assert.match(source, /allowLocalOverride/, 'drift check should compare manifest allowLocalOverride');
    assert.match(source, /LOCAL-OVERRIDE-DRIFT/, 'drift check should report local override drift explicitly');
  });

  it('native L0 compiler routes S6 through workflow trigger template overlays', () => {
    const source = readFileSync('scripts/compile-system-prompt-l0.mjs', 'utf-8');
    assert.doesNotMatch(
      source,
      /const\s+WORKFLOW_TRIGGERS_INLINE\s*=/,
      'native L0 compiler must not keep an inline S6 workflow trigger copy',
    );
    assert.match(
      source,
      /workflow-triggers\.local\.yaml/,
      'native L0 compiler must consider the same local S6 overlay file as the runtime builder',
    );
    assert.match(source, /YAML\.parse/, 'native L0 compiler must load S6 workflow trigger YAML');
  });

  it('Maine Coon S6 template preserves native L0 long-task guardrails', () => {
    const workflowTriggers = YAML.parse(readFileSync('assets/prompt-templates/workflow-triggers.yaml', 'utf-8'));
    const maineCoon = workflowTriggers['maine-coon'];

    assert.equal(typeof maineCoon, 'string', 'maine-coon workflow trigger template must be a string block');
    assert.match(
      maineCoon,
      /### 缅因猫家族治理（fallback 层数检测 F177 Phase D）/,
      'Maine Coon S6 should preserve its fallback-layer governance block from the native overlay',
    );
    assert.match(maineCoon, /### 长任务纪律/, 'Maine Coon S6 should preserve long-task discipline');
    assert.match(
      maineCoon,
      /exec_command session_id 存活 → 续 write_stdin。/,
      'long-task discipline must keep session_id reuse guidance',
    );
    assert.match(
      maineCoon,
      /bash&\/nohup\/disown\/setsid = 伪后台；真后台用 detached spawn \+ unref。/,
      'long-task discipline must keep pseudo-backgrounding guidance',
    );
    assert.match(
      maineCoon,
      /Fire-and-forget → pid\/log\/exit 探针轮询。/,
      'long-task discipline must keep external probe guidance',
    );
  });

  it('desktop package manifests ship prompt template assets used at runtime', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf-8'));
    const innoInstaller = readFileSync('desktop/installer/cat-cafe.iss', 'utf-8');

    const resourceEntries = desktopPackage.build.extraResources ?? [];
    assert.ok(
      resourceEntries.some((entry) => entry.from === '../assets' && entry.to === 'assets'),
      'electron-builder packages must include the full runtime assets tree, including prompt-templates and manifest',
    );
    assert.match(
      innoInstaller,
      /Source:\s*"\.\.\\\.\.\\assets\\\*";\s*DestDir:\s*"\{app\}\\assets"/,
      'Windows installer must include the full runtime assets tree, including prompt-templates and manifest',
    );
  });

  it('prompt overlay writes use the writable project data tree, not packaged assets', () => {
    const loaderSource = readFileSync(
      'packages/api/src/domains/cats/services/context/prompt-template-loader.ts',
      'utf-8',
    );
    const routeSource = readFileSync('packages/api/src/routes/prompt-injection.ts', 'utf-8');

    assert.match(
      loaderSource,
      /TEMPLATE_OVERLAYS_DIR\s*=\s*join\(findMonorepoRoot\(\),\s*['"]\.cat-cafe['"],\s*['"]prompt-overlays['"]\)/,
      'prompt overlays must live under the writable .cat-cafe project data tree',
    );
    assert.match(
      loaderSource,
      /function\s+overlayPath\s*\(\s*filename:\s*string\s*\)/,
      'template loader should centralize overlay path resolution',
    );
    assert.match(
      loaderSource,
      /export\s+function\s+getTemplateOverlayPath\s*\(\s*segmentId:\s*string\s*\)/,
      'routes should use a loader-owned overlay path helper instead of reconstructing asset paths',
    );
    assert.doesNotMatch(
      routeSource,
      /join\(TEMPLATES_DIR,\s*(?:`\$\{fileInfo\.local\}\.bak`|fileInfo\.local)/,
      'overlay save/delete/restore paths must not target packaged assets/prompt-templates',
    );
  });

  it('B1 manifest points at the runtime SessionBootstrap source, not an unused template', () => {
    const manifest = YAML.parse(readFileSync('assets/prompt-injection-manifest.yaml', 'utf-8'));
    const b1 = manifest.segments.find((segment) => segment.id === 'B1');
    assert.ok(b1, 'manifest must contain B1');
    assert.equal(b1.source, 'packages/api/src/domains/cats/services/session/SessionBootstrap.ts');
    assert.equal(b1.sourceType, 'typescript');
    assert.equal(b1.allowLocalOverride, false);

    const loaderSource = readFileSync(
      'packages/api/src/domains/cats/services/context/prompt-template-loader.ts',
      'utf-8',
    );
    assert.doesNotMatch(loaderSource, /\n\s*B1:\s*\{/, 'B1 must not be exposed as a template-backed segment');
    assert.equal(
      existsSync('assets/prompt-templates/b1-session-bootstrap.md'),
      false,
      'B1 must not leave a realistic but unreferenced prompt template file behind',
    );
  });

  it('compiled native L0 strips display-only segment labels', async () => {
    const { compileL0 } = await import('./compile-system-prompt-l0.mjs');
    const compiled = await compileL0({ catId: firstAvailableCatId() });

    assert.doesNotMatch(
      compiled,
      /^── \[[A-Z]\d+] .+──$/m,
      'compiled native L0 must not send source/template display labels to the model',
    );
  });

  it('F231 compiled native L0 preserves capsule and primer carrier contract', async () => {
    const { compileL0 } = await import('./compile-system-prompt-l0.mjs');
    const targetCatId = firstAvailableCatId();
    const profileDir = mkdtempSync(join(tmpdir(), 'f231-l0-profile-'));
    const emptyProfileDir = mkdtempSync(join(tmpdir(), 'f231-l0-empty-profile-'));

    try {
      mkdirSync(join(profileDir, 'relationship'), { recursive: true });
      writeFileSync(
        join(profileDir, 'landy-capsule.md'),
        '蓝莓拿铁是默认饮料。\n遇到取舍题先给结论再给依据。\n',
        'utf-8',
      );
      writeFileSync(
        join(profileDir, 'relationship', `${targetCatId}-primer.md`),
        'THIS TARGET PRIMER BODY MUST NOT BE INJECTED INTO L0',
        'utf-8',
      );

      const targetCompiled = await compileL0({ catId: targetCatId, profileDir });
      assert.match(targetCompiled, /## 主人画像/, 'capsule heading must be injected when landy-capsule.md exists');
      assert.match(targetCompiled, /蓝莓拿铁是默认饮料。/, 'capsule body must be injected into native L0');
      const targetPrimerPointer = `private/profile/relationship/${targetCatId}-primer.md`;
      assert.ok(
        targetCompiled.includes(targetPrimerPointer),
        'native L0 should include only the per-cat primer pointer',
      );
      assert.doesNotMatch(
        targetCompiled,
        /THIS TARGET PRIMER BODY MUST NOT BE INJECTED INTO L0/,
        'native L0 must not inject primer body content',
      );

      const emptyCompiled = await compileL0({ catId: targetCatId, profileDir: emptyProfileDir });
      assert.doesNotMatch(emptyCompiled, /## 主人画像/, 'empty profile must not emit a capsule section');
      assert.doesNotMatch(
        emptyCompiled,
        /\{\{USER_CAPSULE\}\}/,
        'empty profile must not leak the USER_CAPSULE placeholder',
      );

      const otherCatId = availableCatIdExcluding(targetCatId);
      if (otherCatId) {
        const otherCompiled = await compileL0({ catId: otherCatId, profileDir });
        assert.ok(
          !otherCompiled.includes(targetPrimerPointer),
          'cat-specific primer pointer must not leak to another cat',
        );
      }
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
      rmSync(emptyProfileDir, { recursive: true, force: true });
    }
  });

  it('S6 overlay mutations invalidate the native L0 cache', () => {
    const source = readFileSync('packages/api/src/routes/prompt-injection.ts', 'utf-8');
    assert.match(source, /clearL0Cache/, 'overlay write route must import native L0 cache invalidation');
    assert.match(
      source,
      /function\s+invalidateNativeL0CacheForSegment\s*\(\s*segmentId:\s*string\s*\)/,
      'cache invalidation should be centralized by segment id',
    );
    assert.match(
      source,
      /segmentId\s*===\s*['"]S6['"][\s\S]*?clearL0Cache\(\)/,
      'S6 is the workflow-trigger overlay consumed by native L0 and must clear all cached compiled prompts',
    );
    const invalidationCalls = source.match(/invalidateNativeL0CacheForSegment\(id\)/g) ?? [];
    assert.ok(
      invalidationCalls.length >= 3,
      'S6 cache invalidation must run after save, delete, and restore-backup mutations',
    );
  });

  it('compiled preview reads the effective C1 template including local overrides', () => {
    const source = readFileSync('packages/api/src/routes/prompt-injection-preview.ts', 'utf-8');
    assert.match(
      source,
      /const\s+tpl\s*=\s*\(\s*id:\s*string,\s*useOverride\s*=\s*false\s*\)/,
      'compiled preview helper should support choosing effective template content',
    );
    assert.match(
      source,
      /getTemplateRawContent\(id,\s*useOverride\)/,
      'compiled preview helper should pass the override flag through to the template loader',
    );
    assert.match(
      source,
      /tpl\(['"]C1['"],\s*true\)/,
      'C1 preview must show c1-mcp-callback.local.md when an override exists',
    );
  });

  it('compiled preview surfaces native L0 compile failures instead of falling back', () => {
    const source = readFileSync('packages/api/src/routes/prompt-injection-preview.ts', 'utf-8');
    assert.doesNotMatch(
      source,
      /Fallback to S-segment view if L0 compilation fails/,
      'native-L0 preview must not claim success with the non-native S-segment fallback',
    );
    assert.match(
      source,
      /nativeL0CompileError/,
      'native-L0 preview errors should expose the compiler failure explicitly',
    );
  });

  it('compiled preview includes native pack-only context in the user-message preview', () => {
    const apiSource = readFileSync('packages/api/src/routes/prompt-injection-preview.ts', 'utf-8');
    const webSource = readFileSync('packages/web/src/components/settings/CompiledPreviewModal.tsx', 'utf-8');

    assert.match(apiSource, /buildStaticIdentityPackOnly/, 'API preview should compute native pack-only context');
    assert.match(
      apiSource,
      /nativePackContext\s*=\s*buildStaticIdentityPackOnly\(catId\s+as\s+CatId,\s*\{\s*packBlocks\s*\}\)/,
      'native pack context must use the same pack-only builder as native runtime routes',
    );
    assert.match(
      webSource,
      /nativePackContext\?:\s*string/,
      'frontend preview contract should expose native pack context',
    );
    assert.match(
      webSource,
      /isNativeL0\s*&&\s*scenario\s*!==\s*['"]subsequent['"][\s\S]*?msgParts\.push\(nativePackContext\)/,
      'native pack context should render in the user-message preview for first-turn and handoff scenarios',
    );
  });
});
