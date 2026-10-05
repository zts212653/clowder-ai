import { basename, extname } from 'node:path';

const EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.py',
  '.txt',
]);
const DOTFILES = new Set([
  '.gitignore',
  '.npmrc',
  '.eslintrc',
  '.prettierrc',
  '.editorconfig',
  '.env.example',
  '.nvmrc',
  '.dockerignore',
  '.prettierignore',
]);

/** Original F063 edit whitelist, shared by direct human edits and reviewed patch acceptance. */
export function isWorkspaceTextEditable(path: string): boolean {
  return EXTENSIONS.has(extname(path)) || DOTFILES.has(basename(path));
}
