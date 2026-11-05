/**
 * Current C1 author candidate: plugins 2b4f0418c1dd, Contract beta.37 / SDK 0.2.0-beta.21.
 * Exact self-contained darwin-arm64 archives; approval and publication are separate gates.
 * No published release exists for this candidate. Supply the verified archive directory.
 */

export const PLUGIN_SOURCE = Object.freeze({
  repository: 'zts212653/clowder-ai-plugins',
  pullRequest: 54,
  sourceSha: '2b4f0418c1dd957bbafe51774aa7af7596214751',
  artifactBatch: 'post-1614-package-replay-db22707-r1/current-artifacts-r2',
});

/** No release URL is asserted until these exact bytes have been published. */
export const ARTIFACT_RELEASE = null;

/** The version every connector in this batch carries; it is part of each archive's file name. */
export const CONNECTOR_VERSION = '0.1.0-alpha.5';

/** The platform the self-contained archives were built for; the gate refuses to run elsewhere. */
export const ARTIFACT_PLATFORM = Object.freeze({ platform: 'darwin', arch: 'arm64' });

/** `media: false` = the package declares no media delivery (no `streams.read`). */
export const RELEASES = Object.freeze(
  [
    [
      'dingtalk',
      'a28f00e4bcb9f0b6e22ccb3c2c0e9b50a3d5fe6e61b0df2a6ab1eb4050647739',
      'createDingTalkPluginModule',
      true,
    ],
    ['feishu', 'b7b098fe3ff66d6edc33c746ba2fc8f8f6141becffd2286140047c7ddf1364ea', 'createFeishuPluginModule', true],
    [
      'telegram',
      '799be78ba63a287c33f6d953f00f140289b623495a4b67a4e9a7cc4b521414f4',
      'createTelegramPluginModule',
      true,
    ],
    [
      'wecom-agent',
      '0e4084aa86c1b2cbdca366a224c96eeec266f7cf6116ec40af31f1aa6ac4a275',
      'createWeComAgentPluginModule',
      true,
    ],
    [
      'wecom-bot',
      '00703f4d013e298e0517a7b6e48e2f280b52f105d142731c3575cec2fc1913a2',
      'createWeComBotPluginModule',
      true,
    ],
    ['weixin', 'c776990693e47b86ec4505e01211aab26fba656b0987ef393f67c42e6932c180', 'createWeixinPluginModule', true],
    ['xiaoyi', '4655a64241f89158fa9415255a28b8f5eb98ce05e84821301d581a0bf062e768', 'createXiaoyiPluginModule', false],
  ].map(([name, sha, factory, media]) => Object.freeze({ name, sha, factory, media })),
);

/** Two cases per release plus the degraded-block case: what a complete run must execute. */
export const EXPECTED_CASES = RELEASES.length * 2 + 1;

export function archiveFileName(release) {
  return `clowder-ai-connector-${release.name}-${CONNECTOR_VERSION}-darwin-arm64-${release.sha.slice(0, 12)}.tgz`;
}
