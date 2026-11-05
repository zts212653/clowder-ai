import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveInvokeCapabilityRoot } from '../../../../../../config/capabilities/invoke-capability-root.js';
import { isValidSkillName } from '../../../../../../config/governance/skill-sync.js';
import { readEffectiveMountRules } from '../../../../../../config/mount/mount-rules-store.js';
import { buildSkillMountTargets, SHARED_SKILL_REFS_ALIAS } from '../../../../../../utils/skill-mount.js';

function directory(path: string): void {
  if (existsSync(path)) {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Native skill directory is not host-owned: ${path}`);
  } else mkdirSync(path, { mode: 0o700 });
}

const SNAPSHOT_PREFIX = '.cat-cafe-skills-';
const RECEIPT = '.cat-cafe-links.json';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');

function verifyLink(path: string, target: string): void {
  if (!lstatSync(path).isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== target) {
    throw new Error(`Native skill link changed outside the host: ${path}`);
  }
}

function readPublishedSnapshot(path: string, parents: readonly string[]): void {
  const target = resolve(dirname(path), readlinkSync(path));
  if (
    !parents.includes(dirname(target)) ||
    !new RegExp(`^${SNAPSHOT_PREFIX.replaceAll('.', '\\.')}[a-f0-9]{64}$`).test(basename(target))
  ) {
    throw new Error('Native skills pointer changed outside the host');
  }
  directory(target);
  const receiptPath = join(target, RECEIPT);
  if (!lstatSync(receiptPath).isFile()) throw new Error('Invalid native skills receipt');
  const body = readFileSync(receiptPath, 'utf8');
  if (basename(target) !== `${SNAPSHOT_PREFIX}${hash(body)}`)
    throw new Error('Native skills receipt changed outside the host');
  const links = JSON.parse(body) as Record<string, string>;
  for (const [name, source] of Object.entries(links)) verifyLink(join(target, name), source);
  if (readdirSync(target).length !== Object.keys(links).length + 1) throw new Error('Unexpected native skill entry');
}

/** Project/global mounted skills remain the authority; this is only AGY's profile-local view. */
export async function materializeAgyNativeSkills(input: {
  profileHome: string;
  workspace: string;
  runtimeRoot: string;
  userHome?: string;
  /** A run owns config/skills; the account data directory must not gain a run-specific alias. */
  canonicalOnly?: boolean;
}): Promise<string[]> {
  const mainRoot = await resolveInvokeCapabilityRoot(input.runtimeRoot);
  const rules = await readEffectiveMountRules(input.workspace, mainRoot);
  const candidates =
    buildSkillMountTargets(input.workspace, input.userHome ?? homedir(), rules).find((target) => target.id === 'gemini')
      ?.candidates ?? [];
  const links: Record<string, string> = {};
  const readableRoots: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue;
    readableRoots.push(realpathSync(candidate));
    for (const name of readdirSync(candidate)) {
      if ((!isValidSkillName(name) && name !== SHARED_SKILL_REFS_ALIAS) || links[name]) continue;
      const source = join(candidate, name);
      if (!existsSync(source) || !statSync(source).isDirectory()) continue;
      if (name !== SHARED_SKILL_REFS_ALIAS && !existsSync(join(source, 'SKILL.md'))) continue;
      links[name] = realpathSync(source);
    }
  }
  // CLI 1.3.5 migrates its documented legacy skills path into config/skills
  // on first boot. Publish at that canonical location and retain only its alias.
  const parent = join(input.profileHome, '.gemini', 'config');
  const legacyParent = join(input.profileHome, '.gemini', 'antigravity-cli');
  directory(join(input.profileHome, '.gemini'));
  directory(parent);
  if (!input.canonicalOnly) directory(legacyParent);
  const destination = join(parent, 'skills');
  const legacy = join(legacyParent, 'skills');
  const allowedParents = [parent, legacyParent];
  let emptyBootstrap = false;
  if (existsSync(destination)) {
    const entry = lstatSync(destination);
    if (entry.isSymbolicLink()) readPublishedSnapshot(destination, allowedParents);
    else if (entry.isDirectory() && readdirSync(destination).length === 0) emptyBootstrap = true;
    else throw new Error('Native skills conflict with an existing profile entry');
  }
  let emptyLegacy = false;
  if (!input.canonicalOnly) {
    try {
      const entry = lstatSync(legacy);
      if (entry.isSymbolicLink()) {
        if (resolve(legacyParent, readlinkSync(legacy)) !== destination) readPublishedSnapshot(legacy, allowedParents);
      } else if (entry.isDirectory() && readdirSync(legacy).length === 0) emptyLegacy = true;
      else throw new Error('Native skills conflict with an existing legacy profile entry');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // Build an immutable view and publish one pointer. An API crash before this
  // rename leaves the old complete view visible; its partial successor can be
  // finished from the same canonical mounts without trusting an orphan receipt.
  const body = JSON.stringify(Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b))));
  const snapshot = join(parent, `${SNAPSHOT_PREFIX}${hash(body)}`);
  directory(snapshot);
  for (const name of readdirSync(snapshot)) {
    if (name !== RECEIPT && !Object.hasOwn(links, name)) throw new Error('Unexpected native skill snapshot entry');
  }
  for (const [name, target] of Object.entries(links)) {
    const path = join(snapshot, name);
    try {
      verifyLink(path, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  const receiptPath = join(snapshot, RECEIPT);
  if (existsSync(receiptPath)) {
    if (!lstatSync(receiptPath).isFile() || readFileSync(receiptPath, 'utf8') !== body)
      throw new Error('Native skills receipt changed outside the host');
  } else writeFileSync(receiptPath, body, { mode: 0o600, flag: 'wx' });
  const temporary = join(parent, `.cat-cafe-skills-pointer-${randomUUID()}`);
  symlinkSync(snapshot, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  if (emptyBootstrap) rmdirSync(destination);
  renameSync(temporary, destination);
  if (input.canonicalOnly) return [...new Set(readableRoots)];
  const alias = join(legacyParent, `.cat-cafe-skills-pointer-${randomUUID()}`);
  symlinkSync(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  if (emptyLegacy) rmdirSync(legacy);
  renameSync(alias, legacy);
  return [...new Set(readableRoots)];
}

/** Retire only the previous host-published alias before concurrent views are introduced. */
export function retireAgyNativeLegacySkillAlias(profileHome: string): void {
  const parent = join(profileHome, '.gemini', 'config');
  const legacyParent = join(profileHome, '.gemini', 'antigravity-cli');
  const legacy = join(legacyParent, 'skills');
  const entry = lstatSync(legacy, { throwIfNoEntry: false });
  if (!entry) return;
  if (!entry.isSymbolicLink()) {
    if (entry.isDirectory() && readdirSync(legacy).length === 0) {
      rmdirSync(legacy);
      return;
    }
    throw new Error('Native legacy skills are not a host-owned alias');
  }
  const target = resolve(legacyParent, readlinkSync(legacy));
  readPublishedSnapshot(target === join(parent, 'skills') ? target : legacy, [parent, legacyParent]);
  rmSync(legacy);
}
