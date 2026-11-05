import fs from 'node:fs';
import path from 'node:path';
import runtimeConfig from '../runtime-config.js';

const { canonicalWithMissingSuffix } = runtimeConfig;
const within = (parent, target) => {
  const relative = path.relative(parent, target);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

/** Explicit local acceptance setup, never called by production discovery or the installer. */
export function snapshotDshTestConnection({ sourceHome, targetHome, npmCache, includeCredentials = false }) {
  const source = canonicalWithMissingSuffix(sourceHome),
    target = canonicalWithMissingSuffix(targetHome);
  if (within(source, target) || within(target, source)) throw new Error('DSH test home must be separate');
  const verifyTarget = (file) => {
    if (!within(target, canonicalWithMissingSuffix(file))) throw new Error('DSH snapshot target boundary escaped');
  };
  const copied = [];
  const files = [
    'profiles/acp/package.json',
    'profiles/acp/cordis.yml',
    'profiles/acp/cordis.patch.yml',
    'profiles/acp/pnpm-workspace.yaml',
    // Credentials require separate explicit approval for the intended test home.
    ...(includeCredentials ? ['.credentials.yaml'] : []),
  ];
  for (const relative of files) verifyTarget(path.join(targetHome, '.dsh', relative));
  verifyTarget(path.join(targetHome, 'AppData/Local/npm-cache'));
  for (const relative of files) {
    const from = path.join(sourceHome, '.dsh', relative),
      to = path.join(targetHome, '.dsh', relative);
    if (!fs.existsSync(from)) continue;
    if (!fs.lstatSync(from).isFile()) throw new Error('DSH connection must be an ordinary file');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      copied.push(relative);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  // Detection reads this cache; ACP invokes the resolved Node entry directly (never npx).
  // The actual installed CLI stays outside app data, just like an existing PATH executable.
  const from = path.join(npmCache, '_npx'),
    to = path.join(targetHome, 'AppData/Local/npm-cache/_npx');
  if (fs.existsSync(from) && !fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.symlinkSync(path.resolve(from), to, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { copied, sourceModified: false, sessionsCopied: false, existingConfigurationReplaced: false };
}
