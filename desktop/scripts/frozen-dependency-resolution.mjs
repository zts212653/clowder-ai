import fs from 'node:fs';
import path from 'node:path';

/** Model the installed root node_modules while compiling a frozen shared tree. */
export async function withFrozenDependencyResolution(root, action) {
  const dependencies = path.join(root, 'dependencies');
  if (!fs.existsSync(dependencies)) return action();
  const canonical = fs.realpathSync(dependencies);
  const modules = path.join(root, 'node_modules');
  if (fs.existsSync(modules)) {
    if (fs.realpathSync(modules) !== canonical)
      throw new Error('Frozen dependency alias conflicts with existing modules');
    return action();
  }
  fs.symlinkSync(canonical, modules, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    return await action();
  } finally {
    if (!fs.lstatSync(modules).isSymbolicLink() || fs.realpathSync(modules) !== canonical)
      throw new Error('Frozen dependency alias changed during bundling');
    fs.unlinkSync(modules);
  }
}
