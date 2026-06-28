/**
 * Source-code file extensions used by F232 artifact classification and preview.
 *
 * Keep this list focused on files that are both source-like and safe to preview
 * as text. Documentation/config formats such as md/json/yaml stay outside this
 * list so they remain generic file artifacts.
 */
export const SOURCE_CODE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'html',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'psd1',
  'bat',
  'cmd',
  'pl',
  'pm',
  'sql',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
] as const;

export const SOURCE_CODE_EXTENSION_SET = new Set<string>(SOURCE_CODE_EXTENSIONS);

export function isSourceCodeExtension(extension: string): boolean {
  return SOURCE_CODE_EXTENSION_SET.has(extension.toLowerCase());
}
