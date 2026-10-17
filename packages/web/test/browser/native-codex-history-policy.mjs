import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function canonical(directory) {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(directory) === directory) throw error;
    return path.join(await canonical(path.dirname(directory)), path.basename(directory));
  }
}

/** An explicit archive policy is not an archive receipt. The author must still
 * finish persistence acceptance, prove native IDs, back up and archive afterward. */
export async function requireCodexTestHistoryPolicy(instance, policy) {
  assert.ok(instance && path.isAbsolute(instance), 'Supply the owned installed instance before real Codex calls');
  const owner = await canonical(instance);
  let homes = {};
  try {
    homes = JSON.parse(await fs.readFile(path.join(owner, 'client-homes.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.ok(
    homes && typeof homes === 'object' && !Array.isArray(homes),
    'Invalid client homes; do not infer isolation',
  );
  const selected = homes.codex ?? path.join(owner, 'home', '.codex');
  assert.ok(typeof selected === 'string' && path.isAbsolute(selected), 'Invalid native Codex home');
  const nativeHome = await canonical(selected);
  const relative = path.relative(owner, nativeHome);
  const shared = path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
  if (shared)
    assert.equal(
      policy,
      'approved-verified-archive',
      'Codex native history is shared: require an explicit, user-approved verified-archive plan before creating test sessions',
    );
  return {
    nativeHome,
    scope: shared ? 'shared-native-history' : 'instance-owned-home',
    requiresVerifiedArchival: shared,
  };
}
