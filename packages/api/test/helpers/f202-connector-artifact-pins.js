/**
 * F202 C1 cross-repository gate — the one place the approved connector artifacts are pinned.
 *
 * Fifth connector batch after ④ (supersedes the fourth): built from plugins PR #54 at `e2aef8f02872`
 * with the frozen toolchain after #54 absorbed plugins-main #59 (contract beta.23 / SDK 0.2.0-beta.6
 * in the dependency closure; connector code unchanged), verified in the ledger entry
 * 「④ 后第五批 connector 制品」. The self-contained
 * archives are darwin-arm64 builds; they are published unchanged, with SHA256SUMS, as release
 * assets so a reviewer can fetch exactly these bytes. No module here imports Host code, so the
 * mandatory runner can check digests before it rebuilds the Host.
 */

export const PLUGIN_SOURCE = Object.freeze({
  repository: 'zts212653/clowder-ai-plugins',
  pullRequest: 54,
  sourceSha: 'e2aef8f028721b600f35566f05864fd5a73ca24e',
  batch: 5,
});

/** Where reviewers and the mandatory runner fetch the archives: `<owner>/<repo>@<tag>`. */
export const ARTIFACT_RELEASE = Object.freeze({
  repository: 'mindfn/clowder-ai-plugins',
  tag: 'f202-c1-connectors-batch5-e2aef8f02872',
});

/** The platform the self-contained archives were built for; the gate refuses to run elsewhere. */
export const ARTIFACT_PLATFORM = Object.freeze({ platform: 'darwin', arch: 'arm64' });

/** `media: false` = the package declares no media delivery (no `media.read`). */
export const RELEASES = Object.freeze(
  [
    [
      'dingtalk',
      '8a5b9e9422e659fd0d137c7781a4d0507e4cef9cb91c8349d17425d40ca3795e',
      'createDingTalkPluginModule',
      true,
    ],
    ['feishu', 'af6d651783b1d5d6e7f9cbfae9ec3772abeb3cb268f2777995c36a5e21dbea57', 'createFeishuPluginModule', true],
    [
      'telegram',
      '83bf89f0cf8addb937504a94179581a0813599a07935d03d872b38a9e114c386',
      'createTelegramPluginModule',
      true,
    ],
    [
      'wecom-agent',
      '7aaa5b28da3385e49a04f8883569b0fd02341b7becb39b95810794a65734bbb8',
      'createWeComAgentPluginModule',
      true,
    ],
    [
      'wecom-bot',
      '2ec04583c749bb75aae6967febeb9e011dd96083b5f5a25eaffa996f85364711',
      'createWeComBotPluginModule',
      true,
    ],
    ['weixin', 'a0b451f2d8abf4bea66c5bc78a79a9a4d0303dec849afe2e7afbdf7ee0c14bc1', 'createWeixinPluginModule', true],
    ['xiaoyi', '2721c4ed6ef87bb26194a306c99076cd435689ce4b699a51c6bc8ddbe49e72c6', 'createXiaoyiPluginModule', false],
  ].map(([name, sha, factory, media]) => Object.freeze({ name, sha, factory, media })),
);

/** Two cases per release plus the degraded-block case: what a complete run must execute. */
export const EXPECTED_CASES = RELEASES.length * 2 + 1;

export function archiveFileName(release) {
  return `clowder-ai-connector-${release.name}-0.1.0-alpha.0-darwin-arm64-${release.sha.slice(0, 12)}.tgz`;
}
