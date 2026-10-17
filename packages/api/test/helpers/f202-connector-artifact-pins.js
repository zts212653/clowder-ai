/**
 * F202 C1 cross-repository gate — the one place the approved connector artifacts are pinned.
 *
 * Eighth connector batch (supersedes the sixth): built from plugins PR #54 at `553f9e3c7267` with the
 * frozen toolchain and reproducible packaging (canonical shrinkwrap, `npm ci`, deterministic members
 * and metadata). The dependency closure carries contract beta.29 / SDK 0.2.0-beta.12;
 * the connectors are 0.1.0-alpha.2. Verified in the ledger entry 「第八批制品」.
 * The self-contained archives are darwin-arm64 builds; they are
 * published unchanged, with SHA256SUMS, as release assets so a reviewer can fetch exactly these
 * bytes. No module here imports Host code, so the mandatory runner can check digests before it
 * rebuilds the Host.
 */

export const PLUGIN_SOURCE = Object.freeze({
  repository: 'zts212653/clowder-ai-plugins',
  pullRequest: 54,
  sourceSha: '553f9e3c72673be08ea08d0dfbac003c275ecb2f',
  batch: 8,
});

/** Where reviewers and the mandatory runner fetch the archives: `<owner>/<repo>@<tag>`. */
export const ARTIFACT_RELEASE = Object.freeze({
  repository: 'mindfn/clowder-ai-plugins',
  tag: 'f202-c1-batch8-553f9e3c7267',
});

/** The version every connector in this batch carries; it is part of each archive's file name. */
export const CONNECTOR_VERSION = '0.1.0-alpha.2';

/** The platform the self-contained archives were built for; the gate refuses to run elsewhere. */
export const ARTIFACT_PLATFORM = Object.freeze({ platform: 'darwin', arch: 'arm64' });

/** `media: false` = the package declares no media delivery (no `media.read`). */
export const RELEASES = Object.freeze(
  [
    [
      'dingtalk',
      '1e6d0313e853603463924d5796046d4ee864b954c5a0e6507cccddb5611fb2aa',
      'createDingTalkPluginModule',
      true,
    ],
    ['feishu', '3a33fff7b5a0279a48b94db9fd9e590289f51f811e65ade0bc259e105c23f1a5', 'createFeishuPluginModule', true],
    [
      'telegram',
      '7ec4239e64d96b5484a42c1beeed4e498e09fecfc1644da3924c3e1487f41ab9',
      'createTelegramPluginModule',
      true,
    ],
    [
      'wecom-agent',
      '56fd5dd4a8a69603ef2449c09c6673e7ebcdd101e298170deea0969871846d0e',
      'createWeComAgentPluginModule',
      true,
    ],
    [
      'wecom-bot',
      '9c0c9ed83a3e26522f2d6ba8a688242e3d48cf35bd4202b6a41423e11170c54f',
      'createWeComBotPluginModule',
      true,
    ],
    ['weixin', 'e6fe5d0bea4b3c6feb5c4117cb32245a9709aee02d60f8eeb6152484a2739695', 'createWeixinPluginModule', true],
    ['xiaoyi', 'e91756b354dc0ce6e78111cc952ca92882dcdfb63d0c369a20d6d2b2c1144924', 'createXiaoyiPluginModule', false],
  ].map(([name, sha, factory, media]) => Object.freeze({ name, sha, factory, media })),
);

/** Two cases per release plus the degraded-block case: what a complete run must execute. */
export const EXPECTED_CASES = RELEASES.length * 2 + 1;

export function archiveFileName(release) {
  return `clowder-ai-connector-${release.name}-${CONNECTOR_VERSION}-darwin-arm64-${release.sha.slice(0, 12)}.tgz`;
}
