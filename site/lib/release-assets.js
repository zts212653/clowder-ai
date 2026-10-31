/**
 * Release-asset selection for the download buttons.
 *
 * Classic script (NOT an ES module) so index.html keeps working when opened
 * directly via file:// — static ES imports fail there under module CORS, and
 * local file:// preview of the homepage is an expressed contract. The same
 * file is executed by the test suite via node:vm, so production and tests
 * share one implementation (production = test code path).
 *
 * macOS ships parallel arm64 + x64 DMGs from the release workflow
 * (`.github/workflows/build-mac-dmg.yml`). Picking "the first .dmg" would hand
 * roughly half of Mac visitors an installer they cannot run (an arm64 DMG to an
 * Intel Mac, or vice-versa). Resolve each architecture explicitly and, when an
 * arch build is missing, fall back to the releases page rather than ever
 * serving a known-wrong-architecture artifact.
 */
(function (root) {
  'use strict';

  const DMG = /\.dmg$/i;
  const EXE = /\.exe$/i;
  const ARM64 = /(arm64|aarch64|apple[-\s]?silicon)/i;
  const INTEL = /(x64|x86[-_]?64|intel|amd64)/i;
  const UNIVERSAL = /universal/i;

  const nameOf = (asset) => (asset && typeof asset.name === 'string' ? asset.name : '');

  function selectReleaseAssets(assets) {
    const list = Array.isArray(assets) ? assets : [];
    const dmgs = list.filter((a) => DMG.test(nameOf(a)));

    let macUniversal = dmgs.find((a) => UNIVERSAL.test(nameOf(a)));
    // A lone DMG with no architecture tag is unambiguous — serve it to everyone.
    if (!macUniversal && dmgs.length === 1 && !ARM64.test(nameOf(dmgs[0])) && !INTEL.test(nameOf(dmgs[0]))) {
      macUniversal = dmgs[0];
    }

    const macArm = dmgs.find((a) => ARM64.test(nameOf(a))) || macUniversal;
    const macIntel = dmgs.find((a) => INTEL.test(nameOf(a))) || macUniversal;

    const windows = list.find((a) => EXE.test(nameOf(a))) || list.find((a) => /windows/i.test(nameOf(a)));

    return { windows, macArm, macIntel, macUniversal };
  }

  root.ClowderReleaseAssets = { selectReleaseAssets };
})(typeof globalThis !== 'undefined' ? globalThis : this);
