import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sshConfigurationScope } from '../../../../scripts/lib/ssh-configuration-scope.mjs';
import { shellWords, stripShellComments } from '../../../../scripts/native-effect-shell-tokenizer.mjs';

export function reportSystemSshRunnerInputs(
  t,
  { platform = process.platform, env = process.env, directory = '/etc/ssh' } = {},
) {
  const githubActions = env.GITHUB_ACTIONS === 'true';
  const resourceScope = env.CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE;
  const publicShard = resourceScope === 'distributable' || resourceScope === 'shared';
  if (platform !== 'linux' || (!githubActions && !publicShard)) return;
  // This marker requests bounded diagnostics, never proves OS isolation or
  // authorizes an operation. The shard runner owns those separate checks.
  t.diagnostic(
    JSON.stringify({
      kind: 'system_ssh_runner_inputs',
      context: {
        platform,
        githubActions,
        resourceScope: publicShard ? resourceScope : null,
        inputKind: directory === '/etc/ssh' ? 'runner_system' : 'test_fixture',
      },
      ...systemSshRunnerInputs(directory),
    }),
  );
}

// Diagnostic inputs only, never an alternate admission decision. No HOME,
// identity files, environment dump or SSH process is part of this observation.
export function systemSshRunnerInputs(directory = '/etc/ssh') {
  const result = { directory, files: [], scope: { complete: false, reason: 'diagnostic_inputs_incomplete' } };
  try {
    const names = readdirSync(join(directory, 'ssh_config.d'))
      .filter((name) => name.endsWith('.conf'))
      .sort();
    if (names.length > 16) throw new Error('diagnostic_file_limit');
    const paths = [join(directory, 'ssh_config'), ...names.map((name) => join(directory, 'ssh_config.d', name))];
    const roots = [realpathSync(directory), '/usr/lib/ssh', '/usr/lib/openssh', '/usr/lib/systemd'];
    for (const path of paths) {
      const file = systemFile(path, roots);
      const bytes = result.files.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
      if (bytes + Buffer.byteLength(file.content) > 262144) throw new Error('diagnostic_byte_limit');
      result.files.push(file);
    }
    // Includes must stay inside this finite capture, even if a runner's system
    // configuration unexpectedly points at a user directory.
    assertCapturedIncludes(result.files, paths, directory);
    result.scope = sshConfigurationScope('203.0.113.8', [paths[0]]);
  } catch (error) {
    result.scope = { complete: false, reason: error.code ?? error.message };
  }
  return result;
}

function systemFile(path, roots) {
  const physical = realpathSync(path);
  if (!roots.some((root) => physical.startsWith(`${root}/`))) throw new Error('diagnostic_path_out_of_scope');
  const fd = openSync(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('diagnostic_file_not_bounded');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 65536) throw new Error('diagnostic_byte_limit');
    return { path, physical, content: buffer.toString('utf8', 0, length) };
  } finally {
    closeSync(fd);
  }
}

function assertCapturedIncludes(files, paths, directory) {
  for (const file of files)
    for (const line of file.content.split(/\r?\n/)) {
      const words = shellWords(
        stripShellComments(line)
          .trim()
          .replace(/^Include\s*=\s*/i, 'Include '),
      );
      if (words?.[0]?.value.toLowerCase() !== 'include') continue;
      for (const { value } of words.slice(1)) {
        const target = resolve(directory, value);
        if (!paths.includes(target) && target !== join(directory, 'ssh_config.d', '*.conf'))
          throw new Error('diagnostic_include_out_of_scope');
      }
    }
}
