import { expandShortOption, splitOption } from './secret-send-options.mjs';

const ROOT_OPTIONS = {
  values: new Set(['--repo', '-R', '--hostname']),
  flags: new Set(['--help', '-h', '--version']),
};
function policy(values, flags) {
  const valueNames = new Set([...ROOT_OPTIONS.values, ...values.split(' ').filter(Boolean)]);
  return {
    values: valueNames,
    flags: new Set(
      [...ROOT_OPTIONS.flags, ...flags.split(' ').filter(Boolean)].filter((name) => !valueNames.has(name)),
    ),
  };
}
const BODY = '--body -b --body-file -F';
const CREATE = `${BODY} --assignee -a --label -l --milestone -m --project -p --title -t --template -T --recover`;
const EDIT = `${BODY} --title -t --milestone -m --add-assignee --remove-assignee --add-label --remove-label --add-project --remove-project`;
const COMMENT = policy(BODY, '--create-if-none --delete-last --edit-last --yes --editor -e --web -w');

// Arity belongs to the actual operation. In particular, -a is a review flag
// and a create value; -d is a PR/release flag and a gist description value.
const COMMAND_OPTIONS = new Map([
  ['auth:status', policy('--hostname -h --json --jq --template', '--active -a --show-token -t')],
  [
    'api',
    policy(
      '--cache --field -F --header -H --input --jq -q --method -X --preview -p --raw-field -f --template -t',
      '--include -i --paginate --silent --slurp --verbose',
    ),
  ],
  [
    'pr:create',
    policy(
      `${CREATE} --base -B --head -H --reviewer -r`,
      '--draft -d --dry-run --no-maintainer-edit --editor -e --fill -f --fill-first --fill-verbose --web -w',
    ),
  ],
  ['issue:create', policy(`${CREATE} --blocked-by --blocking --parent --type`, '--editor -e --web -w')],
  ['pr:comment', COMMENT],
  ['issue:comment', COMMENT],
  ['pr:edit', policy(`${EDIT} --base -B --add-reviewer --remove-reviewer`, '--remove-milestone')],
  [
    'issue:edit',
    policy(
      `${EDIT} --add-blocked-by --add-blocking --add-sub-issue --parent --remove-blocked-by --remove-blocking --remove-sub-issue --type`,
      '--remove-milestone --remove-parent --remove-type',
    ),
  ],
  ['pr:review', policy(BODY, '--approve -a --comment -c --request-changes -r')],
  [
    'pr:merge',
    policy(
      `${BODY} --author-email -A --match-head-commit --subject -t`,
      '--admin --auto --disable-auto --delete-branch -d --merge -m --rebase -r --squash -s',
    ),
  ],
  ['pr:close', policy('--comment -c', '--delete-branch -d')],
  ['pr:reopen', policy('--comment -c', '')],
  ['pr:ready', policy('', '--undo')],
  ['issue:close', policy('--comment -c --reason -r', '')],
  ['issue:reopen', policy('--comment -c', '')],
  [
    'release:create',
    policy(
      '--repo -R --discussion-category --notes -n --notes-file -F --notes-start-tag --target --title -t',
      '--help --draft -d --prerelease -p --fail-on-no-commits --generate-notes --latest --notes-from-tag --verify-tag',
    ),
  ],
  [
    'release:edit',
    policy(
      '--discussion-category --notes -n --notes-file -F --tag --target --title -t',
      '--draft --latest --prerelease --verify-tag',
    ),
  ],
  ['release:upload', policy('--repo -R', '--help --clobber')],
  ['gist:create', policy('--desc -d --filename -f', '--help --public -p --web -w')],
  ['gist:edit', policy('--add -a --desc -d --filename -f --remove -r', '--help')],
]);

// These built-ins have no input-file upload grammar. Preserve their arguments,
// including read filters/formatting; argument content has already been scanned.
const READ_OPERATIONS = new Set([
  'help',
  'version',
  'completion',
  'auth:token',
  'auth:status',
  'pr:view',
  'pr:list',
  'pr:checks',
  'pr:status',
  'pr:diff',
  'issue:view',
  'issue:list',
  'issue:status',
  'run:view',
  'run:list',
  'run:watch',
  'run:download',
  'repo:view',
  'repo:list',
  'release:view',
  'release:list',
  'release:download',
  'gist:view',
  'gist:list',
  'workflow:view',
  'workflow:list',
  'search:code',
  'search:commits',
  'search:issues',
  'search:prs',
  'search:repos',
]);

// Resolve the command before choosing its payload grammar. Values can spell
// subcommands; only an unconsumed operand can identify the next command level.
export function ghOperation(args) {
  const group = nextCommand(args, 0, ROOT_OPTIONS);
  if (!group.word) return group;
  if (group.word === 'api') return { group: 'api', offset: group.index, actionIndex: group.index };
  const action = nextCommand(args, group.index + 1, groupPrefixOptions(group.word));
  return {
    group: group.word,
    offset: group.index,
    action: action.word,
    actionIndex: action.index,
    unresolved: action.unresolved,
  };
}

function groupPrefixOptions(group) {
  const schemas = [...COMMAND_OPTIONS].filter(([command]) => command.startsWith(`${group}:`)).map(([, value]) => value);
  const values = new Set(ROOT_OPTIONS.values);
  const flags = new Set(ROOT_OPTIONS.flags);
  for (const schema of schemas) {
    for (const name of schema.values) values.add(name);
    for (const name of schema.flags) flags.add(name);
  }
  // Before selecting the action, a spelling with conflicting arities is
  // ambiguous. Refuse it instead of letting one action consume another's flag.
  for (const name of values) {
    if (!flags.has(name)) continue;
    values.delete(name);
    flags.delete(name);
  }
  return { values, flags };
}

function nextCommand(args, start, options) {
  for (let index = start; index < args.length; index++) {
    if (!args[index].startsWith('-')) return { word: args[index], index };
    const width = prefixOptionWidth(args[index], options);
    if (width === null || index + width >= args.length) return { unresolved: true };
    index += width;
  }
  return {};
}

function prefixOptionWidth(word, options) {
  let parts;
  try {
    parts = expandShortOption(word, options.values, options.flags);
  } catch {
    return null;
  }
  let width = 0;
  for (const part of parts) {
    const option = splitOption(part, options.values);
    if (options.values.has(option.name)) {
      if (!option.inline) width = 1;
    } else if (!options.flags.has(option.name)) return null;
  }
  return width;
}

export function ghOptionPolicy(operation) {
  if (operation.unresolved) throw new Error('secret_send_operation_unresolved');
  const command = operation.group === 'api' ? 'api' : `${operation.group}:${operation.action}`;
  if (!operation.group) return { passthrough: true };
  if (READ_OPERATIONS.has(command) || READ_OPERATIONS.has(operation.group)) return { passthrough: true };
  if (
    !operation.action &&
    [...COMMAND_OPTIONS.keys(), ...READ_OPERATIONS].some((key) => key.startsWith(`${operation.group}:`))
  )
    return { passthrough: true };
  const options = COMMAND_OPTIONS.get(command);
  if (!options) throw new Error('secret_send_operation_unsupported: use gh api with explicit input/fields');
  return options;
}
