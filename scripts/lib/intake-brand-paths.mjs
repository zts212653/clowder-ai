import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [mode, root, argument] = process.argv.slice(2);
const decode = (buffer) => new TextDecoder('utf-8', { fatal: true }).decode(buffer).split('\0').filter(Boolean);
const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
function input() {
  const text = readFileSync(0, 'utf8');
  const paths = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean);
  if (!text.startsWith('[') && /[\r\t\\"]/.test(text)) throw Error('legacy_path_scope_unproved');
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || !path || path.includes('\0')))
    throw Error('invalid_path_scope');
  return [...new Set(paths)];
}
let result;
if (mode === 'local') {
  if (!['index', 'worktree'].includes(argument)) throw Error('invalid_path_scope_mode');
  const paths =
    argument === 'index'
      ? decode(git('diff', '--cached', '--name-only', '-z', '--'))
      : [
          ...decode(git('diff', '--name-only', '-z', 'HEAD', '--')),
          ...decode(git('ls-files', '--others', '--exclude-standard', '-z')),
        ];
  result = JSON.stringify([...new Set(paths)]);
} else if (mode === 'count') result = String(input().length);
else if (mode === 'null')
  result = input()
    .map((path) => `${path}\0`)
    .join('');
else if (mode === 'protected') {
  const classifyPath = (path) => {
    const value = JSON.parse(
      execFileSync(process.execPath, [`${root}/scripts/brand-dictionary-helper.mjs`, '--classify-path', path], {
        encoding: 'utf8',
      }),
    );
    if (
      !['brand-sensitive', 'manual-port', 'public-source', 'public-only', 'pass-through', 'safe-cherry-pick'].includes(
        value.classification,
      )
    )
      throw Error('invalid_path_classification');
    return value;
  };
  result = input()
    .filter((path) => ['brand-sensitive', 'manual-port'].includes(classifyPath(path).classification))
    .map((path) => `${path}\0`)
    .join('');
} else throw Error('invalid_path_scope_command');
process.stdout.write(result);
