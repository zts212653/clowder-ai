/**
 * F202 C1 cross-repository gate — the one place the approved connector artifacts are pinned.
 *
 * Sixth connector batch (supersedes the fifth): built from plugins PR #54 at `60d3bfecb9c1` with the
 * frozen toolchain and reproducible packaging (canonical shrinkwrap, `npm ci`, deterministic members
 * and metadata). The dependency closure carries contract beta.27 / SDK 0.2.0-beta.11; Feishu's start
 * no longer leaves an unhandled rejection after stop; the connectors are 0.1.0-alpha.1. Verified in
 * the ledger entry 「第六批制品」. The self-contained archives are darwin-arm64 builds; they are
 * published unchanged, with SHA256SUMS, as release assets so a reviewer can fetch exactly these
 * bytes. No module here imports Host code, so the mandatory runner can check digests before it
 * rebuilds the Host.
 */

export const PLUGIN_SOURCE = Object.freeze({
  repository: 'zts212653/clowder-ai-plugins',
  pullRequest: 54,
  sourceSha: '60d3bfecb9c153352317a1a96fbc94fb9a1b2fb9',
  batch: 6,
});

/** Where reviewers and the mandatory runner fetch the archives: `<owner>/<repo>@<tag>`. */
export const ARTIFACT_RELEASE = Object.freeze({
  repository: 'mindfn/clowder-ai-plugins',
  tag: 'f202-c1-connectors-batch6-60d3bfecb9c',
});

/** The version every connector in this batch carries; it is part of each archive's file name. */
export const CONNECTOR_VERSION = '0.1.0-alpha.1';

/** The platform the self-contained archives were built for; the gate refuses to run elsewhere. */
export const ARTIFACT_PLATFORM = Object.freeze({ platform: 'darwin', arch: 'arm64' });

/** `media: false` = the package declares no media delivery (no `media.read`). */
export const RELEASES = Object.freeze(
  [
    [
      'dingtalk',
      '412fc483bb455b708797edf6d03eb5b921849ba2b151bac2418df732bc7a0001',
      'createDingTalkPluginModule',
      true,
    ],
    ['feishu', '96fea826c973c4ebcf580c8fe14a1d43fd21858b90a81d0307e673d1c6a4bf70', 'createFeishuPluginModule', true],
    [
      'telegram',
      'ea16a927b0acd93d3f4f677b061309680be99827252784ff88747185e987d5d5',
      'createTelegramPluginModule',
      true,
    ],
    [
      'wecom-agent',
      '2206b37d6d2a5c4cc7065babaf9bbba5ae4c89378cca63e6dbccb13dab91724f',
      'createWeComAgentPluginModule',
      true,
    ],
    [
      'wecom-bot',
      'dfcfeed7458c4ff2f343dc9c5d9cade3f41508b7d1629eacba2892004422c77e',
      'createWeComBotPluginModule',
      true,
    ],
    ['weixin', '341d32ac953fe1e60fb9de30581af9ad80a4ae24079018d85613eb080066a5bc', 'createWeixinPluginModule', true],
    ['xiaoyi', '54e442698339a369e90e2936276a91208db63e1df42569432b31edb8b9c11131', 'createXiaoyiPluginModule', false],
  ].map(([name, sha, factory, media]) => Object.freeze({ name, sha, factory, media })),
);

/** Two cases per release plus the degraded-block case: what a complete run must execute. */
export const EXPECTED_CASES = RELEASES.length * 2 + 1;

export function archiveFileName(release) {
  return `clowder-ai-connector-${release.name}-${CONNECTOR_VERSION}-darwin-arm64-${release.sha.slice(0, 12)}.tgz`;
}
