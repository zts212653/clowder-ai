import { expandShortOption, sendArguments, splitOption } from './secret-send-options.mjs';

const ROOT_VALUES = new Set(['--repo', '-R', '--hostname']);
const SHORT_FLAGS = new Set(['-a', '-c', '-d', '-e', '-f', '-h', '-i', '-m', '-p', '-r', '-s', '-t', '-w']);
const BODY = '--body -b --body-file -F';
const CREATE = `${BODY} --assignee -a --label -l --milestone -m --project -p --recover --template -T --title -t`;
const EDIT = `${BODY} --title -t --milestone -m --add-assignee --remove-assignee --add-label --remove-label --add-project --remove-project`;
const RELEASE = '--discussion-category --notes -n --notes-file -F --target --title -t';
const GIST = '--desc -d --filename -f';
const FORMAT = '--json --jq -q --template -t';

// Value roles distinguish payloads, metadata and help for the selected action.
// In particular, -m is a milestone value for pr create/edit and a flag for pr merge.
const VALUE_ROLES = new Map(
  Object.entries({
    api: '--input --field -F --raw-field -f --header -H --method -X --jq -q --template -t --preview -p --cache',
    'pr:create': `${CREATE} --base -B --head -H --reviewer -r`,
    'pr:edit': `${EDIT} --base -B --add-reviewer --remove-reviewer`,
    'pr:comment': BODY,
    'pr:review': BODY,
    'pr:merge': `${BODY} --author-email -A --match-head-commit --subject -t`,
    'pr:close': '--comment -c',
    'pr:reopen': '--comment -c',
    'pr:view': FORMAT,
    'pr:list': `${FORMAT} --app --assignee -a --author -A --base -B --head -H --label -l --limit -L --search -S --state -s`,
    'pr:status': FORMAT,
    'pr:checks': `${FORMAT} --interval -i`,
    'pr:diff': '--color --exclude -e',
    'issue:create': `${CREATE} --blocked-by --blocking --parent --type`,
    'issue:edit': `${EDIT} --add-blocked-by --add-blocking --add-sub-issue --parent --remove-blocked-by --remove-blocking --remove-sub-issue --type`,
    'issue:comment': BODY,
    'issue:close': '--comment -c --reason -r',
    'issue:reopen': '--comment -c',
    'release:create': `${RELEASE} --notes-start-tag`,
    'release:edit': `${RELEASE} --tag`,
    'release:upload': '',
    'gist:create': GIST,
    'gist:edit': `${GIST} --add -a --remove -r`,
    'gist:view': '--filename -f',
    'ssh-key:add': '--title -t --type',
    'auth:status': '--hostname -h --json --jq --template',
    'run:rerun': '--job -j',
    'label:list': `${FORMAT} --search -S --limit -L --sort --order`,
  }).map(([key, values]) => [key, new Set([...ROOT_VALUES, ...values.split(' ').filter(Boolean)])]),
);
const CREATE_ALIAS = new Set(['gist', 'release', 'pr', 'issue']);

// Cobra accepts values before the subcommand. Use the group only to find the action.
const PREFIX_VALUES = new Map();
for (const [key, values] of VALUE_ROLES) {
  const [group] = key.split(':');
  const prefix = PREFIX_VALUES.get(group) ?? new Set();
  for (const value of values) prefix.add(value);
  PREFIX_VALUES.set(group, prefix);
}

export function ghOperation(args) {
  const group = nextCommand(args, 0, ROOT_VALUES);
  if (!group.word) return group;
  if (group.word === 'api') return { group: 'api', actionIndex: group.index };
  const action = nextCommand(args, group.index + 1, PREFIX_VALUES.get(group.word) ?? ROOT_VALUES);
  return {
    group: group.word,
    action: action.word === 'new' && CREATE_ALIAS.has(group.word) ? 'create' : action.word,
    actionIndex: action.index,
    unresolved: action.unresolved,
  };
}

function nextCommand(args, start, values) {
  for (let index = start; index < args.length; index++) {
    const word = args[index];
    if (!word.startsWith('-')) return { word, index };
    if (word === '--') return { unresolved: true };
    const options = expandShortOption(word, values, SHORT_FLAGS, true).map((part) => splitOption(part, values));
    if (options.some(({ name, inline }) => values.has(name) && !inline) && ++index >= args.length)
      return { unresolved: true };
  }
  return {};
}

function operationKey({ group, action }) {
  return group === 'api' ? group : `${group}:${action}`;
}

export function ghParameters(args, operation) {
  return sendArguments(args, VALUE_ROLES.get(operationKey(operation)) ?? ROOT_VALUES, SHORT_FLAGS, {
    passthroughUnknown: true,
  });
}

export function ghHelpEnabled(parameters) {
  const help = parameters.findLast(({ kind, name }) => kind === 'flag' && (name === '--help' || name === '-h'));
  return Boolean(help && /^(?:--help|-h)(?:=(?:1|t|T|TRUE|true|True))?$/.test(help.word));
}

/** The native read classifier needs known argument roles for the selected action. */
export function isGhHelpRequest(args, operation = ghOperation(args)) {
  const { group, action, unresolved } = operation;
  const known = !group || (action ? VALUE_ROLES.has(operationKey(operation)) : PREFIX_VALUES.has(group));
  if (unresolved || !known) return false;
  try {
    return ghHelpEnabled(ghParameters(args, operation));
  } catch {
    return false;
  }
}

export function isGhObservation(args) {
  const operation = ghOperation(args);
  return (
    isGhHelpRequest(args, operation) ||
    (operation.group === 'auth' && operation.action === 'status') ||
    (operation.group === 'label' && operation.action === 'list')
  );
}
