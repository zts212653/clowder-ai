import { commandName } from '../native-effect-shell-tokenizer.mjs';
import { stoppedDeploymentsIn } from './self-host-deployments.mjs';
import { executedInvocations, splitCommandLines } from './shell-invocation.mjs';

/**
 * F300 -- work out what a command line would actually stop.
 *
 * Two rules carry this module, and both were learned by getting them wrong.
 *
 * What a command runs is not this module's question: `shell-invocation.mjs`
 * answers that once, for wrappers, shell strings, pipeline stages and command
 * substitutions alike, and hands back whether it could read all of it. Here we
 * only ask which of those invocations stop something, and what they name.
 *
 * And coverage has to be proven forwards, not assumed from a match. Finding a
 * number is not resolving the target set: `kill -- 9999 0` also signals the
 * caller's whole process group, `kill -- 9999 -1` signals everything, and
 * `cat host.pid | xargs kill 9999` appends operands nobody here can read. Each
 * of those has to come out unresolved, or a single readable pid launders the
 * rest.
 */

const PATTERN_KILLERS = new Set(['pkill', 'killall']);
const KILL_VERBS = new Set(['kill', ...PATTERN_KILLERS]);
const SERVICE_MANAGERS = new Set(['redis-cli', 'systemctl', 'launchctl', 'supervisorctl', 'pm2', 'docker', 'brew']);
const SERVICE_STOP_VERBS = new Set(['shutdown', 'stop', 'restart', 'kill', 'down']);
/** Only a bare literal probe. `kill -0 9999; pkill ...` is not one command. */
const LIVENESS_PROBE_ONLY = /^\s*kill\s+-0\s+\d+\s*$/i;
/**
 * Used for one thing only: deciding whether a construct we *could not read*
 * has to fail closed. Never a verdict on its own -- a command whose executed
 * content is unreadable and mentions stopping cannot be shown not to be us,
 * while one that mentions nothing of the kind is not evidence of a stop.
 */
const STOP_VOCABULARY = /\b(?:kill|pkill|killall|shutdown|stop|restart)/i;

/**
 * The operands a signal command would act on, given everything after the verb.
 *
 * Returns `undefined` when the set cannot be established -- an operand we
 * cannot read, or a broadcast selector. `0` means "my whole process group" and
 * a negative number means a process group or, at `-1`, everything on the
 * machine; none of those is a set we can compare against ours, so none of them
 * may be treated as resolved.
 */
function signalOperands(operands) {
  const pids = [];
  let sawEndOfOptions = false;
  for (let index = 0; index < operands.length; index++) {
    const token = operands[index];
    if (token === '--') {
      sawEndOfOptions = true;
      continue;
    }
    if (!sawEndOfOptions && token === '-s') {
      index += 1;
      continue;
    }
    if (!sawEndOfOptions && /^-[A-Za-z]/.test(token)) continue; // -TERM, -s
    if (/^\d+$/.test(token)) {
      const pid = Number(token);
      if (pid <= 1) return undefined; // 0 = caller's process group; 1 = init.
      pids.push(pid);
      continue;
    }
    // Negative selectors are process groups (-1 is every process), and anything
    // non-numeric here is a value we did not read.
    return undefined;
  }
  return { pids };
}

/**
 * Which invocation is the killer here, and what follows its verb.
 *
 * The verb is read as an executable name, not as a literal: `/bin/kill` and
 * `kill` are the same program, and spelling one of them out in full is not a
 * permission.
 */
function killerOperands(invocation) {
  if (KILL_VERBS.has(invocation.name ?? '')) {
    if (PATTERN_KILLERS.has(invocation.name)) return { isKiller: true, operands: undefined };
    return { isKiller: true, operands: invocation.operands };
  }
  if (invocation.name === 'xargs') {
    const verbIndex = invocation.operands.findIndex((token) => KILL_VERBS.has(commandName(token) ?? ''));
    if (verbIndex < 0) return { isKiller: false };
    if (PATTERN_KILLERS.has(commandName(invocation.operands[verbIndex]))) {
      return { isKiller: true, operands: undefined };
    }
    return { isKiller: true, operands: invocation.operands.slice(verbIndex + 1), consumesStdin: true };
  }
  return { isKiller: false };
}

function isServiceStop(invocation) {
  return (
    SERVICE_MANAGERS.has(invocation.name ?? '') && invocation.operands.some((token) => SERVICE_STOP_VERBS.has(token))
  );
}

/**
 * What an `lsof` producer would print, but only when every one of its arguments
 * is understood.
 *
 * Two things make this strict. Its selection criteria are OR by default (`man
 * lsof`, GENERAL DESCRIPTION), so `lsof -t -p 4242 -i tcp:39003` prints pid 4242
 * *as well as* whoever holds that port -- dropping the `-p` would hide a target.
 * And any flag we do not model could widen the selection in a way we cannot
 * predict, so an unrecognised argument makes the whole producer unreadable
 * rather than partially read.
 *
 * @returns {{pids: number[], ports: number[]} | undefined}
 */
function lsofSelection(invocation) {
  if (!invocation || invocation.name !== 'lsof') return undefined;
  const operands = invocation.operands;

  const pids = [];
  const ports = [];
  let terse = false;

  for (let index = 0; index < operands.length; index++) {
    const token = operands[index];
    // Combined short flags, e.g. -ti or -ti:PORT.
    const combined = token.match(/^-([a-zA-Z]+)(.*)$/);
    if (!combined) return undefined; // A bare operand is a file/name selector we do not model.
    const [, flags, inlineValue] = combined;
    if (!/^[ti]+$/.test(flags) && !/^[tip]+$/.test(flags)) return undefined;

    if (flags.includes('t')) terse = true;
    let value = inlineValue;
    if (!value && (flags.includes('i') || flags.includes('p'))) {
      value = operands[index + 1];
      index += 1;
    }

    if (flags.includes('p')) {
      // `-p s` takes a comma-separated PID set (`man lsof`), so parsing the
      // prefix and stopping would silently drop every target after the first
      // comma while still claiming the producer was fully understood.
      const listed = String(value ?? '').split(',');
      const parsed = listed.map((entry) => (/^\d+$/.test(entry) ? Number(entry) : Number.NaN));
      if (parsed.some((pid) => !Number.isSafeInteger(pid) || pid <= 1)) return undefined;
      pids.push(...parsed);
      continue;
    }
    if (flags.includes('i')) {
      const port = String(value ?? '').match(/^(?:tcp|udp)?:?(\d{2,5})$/i);
      if (!port) return undefined; // Host/protocol selectors we do not model.
      ports.push(Number(port[1]));
    }
  }

  // Without -t the output carries headers rather than a bare pid list, so it is
  // not something a killer consumes in the shape we are reasoning about.
  if (!terse || (pids.length === 0 && ports.length === 0)) return undefined;
  return { pids, ports };
}

function servicePorts(operands) {
  return operands.flatMap((token, index) => {
    if (token === '-p' || token === '--port') return operands[index + 1] ? [Number(operands[index + 1])] : [];
    const inline = token.match(/^--port=(\d+)$/);
    return inline ? [Number(inline[1])] : [];
  });
}

/**
 * Resolve the stop targets named across these pipelines.
 *
 * `xargs` is the case that matters here: its operand list is whatever it is
 * given plus whatever arrives on stdin, so naming a pid inline proves nothing
 * about the rest. Only the stage feeding it directly can describe that stdin,
 * and only when every argument of that producer is understood.
 */
function resolveStopTargets(pipelines) {
  const pids = [];
  const ports = [];
  let unresolved = false;
  let stops = false;

  for (const pipeline of pipelines) {
    for (const [index, invocation] of pipeline.entries()) {
      const killer = killerOperands(invocation);
      if (killer.isKiller) {
        stops = true;
        if (killer.consumesStdin) {
          // Only what feeds this stage directly can describe its stdin. An
          // earlier producer says nothing once something in between replaces
          // the stream: in `lsof -ti tcp:P | cat host.pid | xargs kill` the
          // pids come from the file, and the port never constrained them.
          const producer = index > 0 ? lsofSelection(pipeline[index - 1]) : undefined;
          if (producer) {
            pids.push(...producer.pids);
            ports.push(...producer.ports);
          } else {
            unresolved = true;
          }
        }
        // Inline operands still count, but they never make stdin readable.
        const operands = killer.operands === undefined ? undefined : signalOperands(killer.operands);
        if (operands) pids.push(...operands.pids);
        else unresolved = true;
        continue;
      }

      if (isServiceStop(invocation)) {
        stops = true;
        ports.push(...servicePorts(invocation.operands));
      }
    }
  }

  return { pids, ports, unresolved, stops };
}

/**
 * @returns {readonly {stopClass: boolean, unresolved: boolean, pids: number[], ports: number[],
 *   deployments: {deploymentId?: string, projectRoot?: string}[], text: string}[]}
 */
export function analyseCommands(raw, cwd) {
  return splitCommandLines(String(raw ?? '')).map((command) => {
    const quiet = { stopClass: false, unresolved: false, pids: [], ports: [], deployments: [], text: command };
    if (LIVENESS_PROBE_ONLY.test(command)) return quiet;

    const { pipelines, complete } = executedInvocations(command, { cwd });
    const deployments = stoppedDeploymentsIn(pipelines.flat(), cwd);
    const { pids, ports, unresolved, stops } = resolveStopTargets(pipelines);

    // Executed content we could not read is only a reason to fail closed when
    // something about it suggests stopping. Otherwise an unparsed construct
    // would deny every command with a `$VAR` in it.
    const unreadableStop = !complete && STOP_VOCABULARY.test(command);
    if (deployments.length === 0 && !stops && !unreadableStop) return quiet;

    const namesNothing = pids.length === 0 && ports.length === 0 && deployments.length === 0;
    return {
      stopClass: true,
      unresolved: unresolved || namesNothing || unreadableStop,
      pids,
      ports,
      deployments,
      text: command,
    };
  });
}
