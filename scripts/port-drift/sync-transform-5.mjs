import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { ROOT } from './context.mjs';

export function registerSyncTransformPart5() {
  it('desktop installer runs F180 agent hook sync under the invoking user profile', () => {
    const inno = readFileSync(resolve(ROOT, 'desktop/installer/cat-cafe.iss'), 'utf-8');
    const postInstall = readFileSync(resolve(ROOT, 'desktop/scripts/post-install-offline.ps1'), 'utf-8');
    const adminPostInstallEntry = inno
      .split(/\r?\n(?=Filename:)/u)
      .find(
        (entry) =>
          /^Filename: "powershell\.exe";/u.test(entry) &&
          /Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""\{app\}\\scripts\\post-install-offline\.ps1"" -AppDir ""\{app\}""/u.test(
            entry,
          ) &&
          /StatusMsg: "Configuring Clowder AI\.\.\."/u.test(entry) &&
          /Flags: runhidden waituntilterminated(?:;|\r?$)/mu.test(entry) &&
          !/Flags:[^\r\n]*runasoriginaluser/u.test(entry),
      );

    assert.match(
      inno,
      /-AgentHooksOnly[\s\S]*Flags: runhidden waituntilterminated runasoriginaluser/,
      'Windows installer should run user-level hook sync with original user credentials, not the elevated admin profile',
    );
    assert.ok(adminPostInstallEntry, 'Windows installer should keep the elevated post-install entry');
    assert.doesNotMatch(
      adminPostInstallEntry,
      /-AgentHooksOnly/,
      'admin post-install step should not also run AgentHooksOnly in the elevated profile',
    );
    assert.match(
      postInstall,
      /sync-agent-hooks-offline\.mjs/,
      'post-install should invoke the offline hook sync helper',
    );
    assert.ok(
      /\$targetRoot = Resolve-AgentHookTargetRoot/u.test(postInstall) ||
        /\$targetRoot = Invoke-AgentHookPhase 'resolve-profile' \{[\s\S]*?\$profileRoot = Resolve-AgentHookTargetRoot[\s\S]*?return \$profileRoot[\s\S]*?\}/u.test(
          postInstall,
        ),
      'offline helper target should resolve the invoking user profile, including a diagnostic phase wrapper',
    );
    assert.match(postInstall, /--target-root\s+\$targetRoot/u, 'offline helper should receive the resolved target');
    assert.match(
      postInstall,
      /Agent CLI hook sync failed[\s\S]*Hub health check can repair it later/,
      'post-install hook sync failure should be a nonfatal warning',
    );
  });

  it('desktop first-run mirrors F180 hook truth source into the writable API project', () => {
    const serviceManager = readFileSync(resolve(ROOT, 'desktop/service-manager.js'), 'utf-8');

    assert.match(
      serviceManager,
      /const mirrors = \[[^\]]*'\.claude'[^\]]*\]/,
      'desktop service manager should mirror .claude into the writable project root for API hook health',
    );
  });

  it('sync-to-opensource.sh leaves sync tag publication to scripts/publish-sync-tag.sh', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    const publishScript = readFileSync(resolve(ROOT, 'scripts/publish-sync-tag.sh'), 'utf-8');
    assert.doesNotMatch(
      content,
      /git -C "\$SOURCE_DIR" tag "\$SYNC_TAG"/,
      'sync-to-opensource should not create a sync tag before the target sync lands',
    );
    assert.doesNotMatch(
      content,
      /git -C "\$SOURCE_DIR" push origin "refs\/tags\/\$SYNC_TAG"/,
      'sync-to-opensource should not publish a sync tag before the target sync is visible upstream',
    );
    assert.match(
      content,
      /if \[ "\$PREFLIGHT" = false \] && \[ "\$DRY_RUN" = false \] && \[ "\$VALIDATE" = false \]; then[\s\S]*After merge: \$PUBLISH_HANDOFF_CMD/,
      'sync-to-opensource should only print the post-merge publish handoff for real sync runs',
    );
    assert.match(
      content,
      /PUBLISH_HANDOFF_CMD="bash scripts\/publish-sync-tag\.sh --source-sha=\$SOURCE_SHA --push"/,
      'sync-to-opensource should bind the post-merge publish handoff to the exported source commit',
    );
    assert.match(
      content,
      /PUBLISH_HANDOFF_CMD="CLOWDER_AI_DIR=\$\(printf '%q' "\$TARGET_DIR"\) \$PUBLISH_HANDOFF_CMD"/,
      'sync-to-opensource should preserve a custom CLOWDER_AI_DIR in the publish handoff',
    );
    assert.match(
      publishScript,
      /git -C "\$repo" tag "\$SYNC_TAG" "\$sha"/,
      'post-merge lane should contain a real tag creation command',
    );
    assert.match(
      publishScript,
      /TARGET_SHA=\$\(resolve_latest_landed_sync_commit "\$TARGET_MAIN_REF"\)/,
      'post-merge lane should auto-detect the latest landed target sync commit when --target-sha is omitted',
    );
    assert.match(
      publishScript,
      /ensure_tag_points_to "\$SOURCE_DIR" "cat-cafe" "\$SOURCE_SHA"/,
      'post-merge lane should have a real source-tag publication command',
    );
    assert.match(
      publishScript,
      /ensure_tag_points_to "\$TARGET_DIR" "clowder-ai" "\$TARGET_SHA"/,
      'post-merge lane should advance the matching clowder-ai tag too',
    );
  });

  it('sync-to-opensource.sh guards empty delta override arrays with a scalar count under Bash 3.2 nounset', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    assert.match(
      content,
      /DELTA_GATE_OVERRIDES=\(\)\s+DELTA_GATE_OVERRIDE_COUNT=0/,
      'override argv state must initialise a scalar count next to the Bash array',
    );
    assert.match(
      content,
      /DELTA_GATE_OVERRIDES\+=\("\$arg"\)\s+DELTA_GATE_OVERRIDE_COUNT=\$\(\(DELTA_GATE_OVERRIDE_COUNT \+ 1\)\)/,
      'split-form --override parsing must increment the scalar override count',
    );
    assert.match(
      content,
      /DELTA_GATE_OVERRIDES\+=\("\$override_value"\)\s+DELTA_GATE_OVERRIDE_COUNT=\$\(\(DELTA_GATE_OVERRIDE_COUNT \+ 1\)\)/,
      'equals-form --override parsing must increment the scalar override count',
    );
    const guardedOverrideLoops = [
      ...content.matchAll(
        /if \[ "\$DELTA_GATE_OVERRIDE_COUNT" -gt 0 \]; then\s+for ovr in "\$\{DELTA_GATE_OVERRIDES\[@\]\}"; do/g,
      ),
    ];
    assert.equal(
      guardedOverrideLoops.length,
      3,
      'validate, dry-run, and production delta gates must guard empty DELTA_GATE_OVERRIDES before expanding it',
    );
    assert.doesNotMatch(
      content,
      /\$\{#DELTA_GATE_OVERRIDES\[@\]\}/,
      'delta gate override guards should not use Bash array-length expansion under nounset',
    );
    assert.doesNotMatch(
      content,
      /DELTA_GATE_(?:TARGET_OWNED|OVERRIDE)_ARGS=\(\)/,
      'delta gate optional args should use "$@" so empty argument groups are safe under Bash 3.2 nounset',
    );
    assert.doesNotMatch(
      content,
      /\$\{DELTA_GATE_(?:TARGET_OWNED|OVERRIDE)_ARGS\[@\]\}/,
      'delta gate optional args should not expand empty arrays under Bash 3.2 nounset',
    );
  });

  it('sync-to-opensource.sh supports release-intended source snapshot tags and provenance mapping', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    assert.match(
      content,
      /--release-tag=\*\) RELEASE_TAG="\$\{arg#--release-tag=\}" ;;/,
      'sync-to-opensource should parse --release-tag',
    );
    assert.match(
      content,
      /SOURCE_SNAPSHOT_TAG="\$\(derive_source_snapshot_tag "\$RELEASE_TAG"\)"/,
      'sync-to-opensource should derive a source snapshot tag from the release tag',
    );
    assert.match(
      content,
      /"release_tag": \$RELEASE_TAG_JSON,/,
      'sync-to-opensource should persist release_tag in .sync-provenance.json',
    );
    assert.match(
      content,
      /"source_snapshot_tag": \$SOURCE_SNAPSHOT_TAG_JSON,/,
      'sync-to-opensource should persist source_snapshot_tag in .sync-provenance.json',
    );
    assert.match(
      content,
      /ensure_source_snapshot_tag "\$SOURCE_SNAPSHOT_TAG" "\$SOURCE_SHA" "\$RELEASE_TAG"/,
      'sync-to-opensource should auto-create the source snapshot tag before touching the real target',
    );
    assert.match(
      content,
      /git -C "\$SOURCE_DIR" tag -a "\$tag" "\$sha" -m "source snapshot for clowder-ai \$release_tag"/,
      'release-intended sync should create an annotated source snapshot tag',
    );
    assert.match(
      content,
      /git -C "\$SOURCE_DIR" push origin "refs\/tags\/\$tag"/,
      'release-intended sync should publish the source snapshot tag to origin',
    );
    assert.match(
      content,
      /require_release_source_commit_on_main\(\) \{/,
      'release-intended sync should define a guard ensuring the source snapshot commit is on origin\\/main',
    );
    assert.match(
      content,
      /require_release_source_commit_on_main "\$SOURCE_SHA"/,
      'release-intended sync should verify the source commit is reachable from origin\\/main before syncing',
    );
  });

  it('sync-hotfix.sh selects the latest sync baseline by mirrored target tag commit time', () => {
    const hotfix = readFileSync(resolve(ROOT, 'scripts/sync-hotfix.sh'), 'utf-8');
    assert.match(
      hotfix,
      /git -C "\$SOURCE_DIR" fetch --quiet --force --prune --prune-tags origin[\s\\]+"\+refs\/tags\/sync\/\*:refs\/tags\/sync\/\*"/,
      'hotfix lane should refresh cat-cafe sync tags from origin before auto-selecting the baseline',
    );
    assert.match(
      hotfix,
      /git -C "\$TARGET_DIR" fetch --quiet origin main/,
      'hotfix lane should refresh clowder-ai origin\\/main before auto-selecting the baseline',
    );
    assert.match(
      hotfix,
      /TARGET_SYNC_TAG_REFS="refs\/cat-cafe-hotfix-sync-tags"/,
      'hotfix lane should mirror clowder-ai sync tags into a dedicated local ref namespace',
    );
    assert.doesNotMatch(
      hotfix,
      /git -C "\$TARGET_DIR" fetch --quiet --force origin[\s\\]+"\+refs\/tags\/sync\/\*:refs\/tags\/sync\/\*"/,
      'hotfix lane should not mirror sync tags into clowder-ai local tag refs during baseline selection',
    );
    assert.match(
      hotfix,
      /git -C "\$TARGET_DIR" fetch --quiet --force --prune origin[\s\\]+"\+refs\/tags\/sync\/\*:\$TARGET_SYNC_TAG_REFS\/sync\/\*"/,
      'hotfix lane should force-refresh the mirrored clowder-ai sync tag namespace',
    );
    assert.match(
      hotfix,
      /merge-base --is-ancestor[\s\\]+"\$TARGET_SYNC_TAG_REFS\/\$tag\^\{commit\}" refs\/remotes\/origin\/main/,
      'hotfix lane should ignore mirrored target sync tags that are no longer reachable from clowder-ai origin/main',
    );
    assert.match(
      hotfix,
      /show -s --format=%ct "\$TARGET_SYNC_TAG_REFS\/\$tag\^\{commit\}"/,
      'hotfix lane should compare mirrored clowder-ai tag commit times when choosing the latest sync baseline',
    );
    assert.match(
      hotfix,
      /rev-parse --verify "\$TARGET_SYNC_TAG_REFS\/\$SYNC_TAG\^\{commit\}"/,
      'hotfix lane should require explicit --tag baselines to exist in the mirrored clowder-ai origin tag namespace',
    );
    assert.match(
      hotfix,
      /merge-base --is-ancestor[\s\\]+"\$TARGET_SYNC_TAG_REFS\/\$SYNC_TAG\^\{commit\}" refs\/remotes\/origin\/main/,
      'hotfix lane should reject explicit --tag baselines that are no longer on clowder-ai origin/main',
    );
    assert.doesNotMatch(
      hotfix,
      /tag -l 'sync\/\*' --sort=-version:refname \| head -1/,
      'hotfix lane should not rely on tag-name sort alone for latest-sync selection',
    );
  });
}
