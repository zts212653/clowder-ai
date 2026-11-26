import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withAgyCommandLedger } from './lib/agy-command-ledger-store.mjs';
import { readAgyDataInputContract } from './lib/agy-data-input-contract.mjs';
import { kernelPath } from './lib/shell-directory.mjs';

function extractTaskIdFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = text.match(/task id:\s*([^\s"'`]+)/i);
  return match?.[1] ?? null;
}

function hydrateEntriesFromTranscript(entries, transcriptPath, conversationId) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) return false;
  let dirty = false;
  try {
    const stat = lstatSync(transcriptPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024) return false;
    const lines = readFileSync(transcriptPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.includes('task id:')) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const stepIdx = typeof parsed?.step_index === 'number' ? parsed.step_index : parsed?.stepIdx;
      const nativeRunning = parsed?.type === 'GENERIC' && parsed.source === 'MODEL' && parsed.status === 'RUNNING';
      const legacyResult = parsed?.type === 'TOOL_CALL' && parsed.status === 'DONE';
      const text = nativeRunning ? parsed.content : legacyResult ? parsed.output : null;
      const taskId = extractTaskIdFromText(text);
      if (typeof stepIdx !== 'number' || !taskId) continue;
      const description =
        nativeRunning && typeof text === 'string'
          ? text.match(/(?:^|\n)Task Description: ([\s\S]*?)\nTask logs are available at:/)?.[1]
          : null;
      for (const entry of entries) {
        if (entry.conversationId === conversationId && entry.stepIdx === stepIdx && entry.taskId !== taskId) {
          if (nativeRunning && description !== entry.executedCommand) continue;
          entry.taskId = taskId;
          dirty = true;
        }
      }
    }
  } catch {
    return dirty;
  }
  return dirty;
}

export function recordApprovedAgyCommand(payload, cwd, command, options = {}, executedCommand = command) {
  const conversationId = payload?.conversationId;
  if (typeof conversationId !== 'string' || !conversationId || !options.profileHome) return;
  withAgyCommandLedger(options.profileHome, (store) =>
    store.append({
      callId: typeof payload?.toolCall?.id === 'string' ? payload.toolCall.id : null,
      conversationId,
      stepIdx: typeof payload?.stepIdx === 'number' ? payload.stepIdx : null,
      taskId: null,
      cwd,
      command,
      executedCommand,
      dataInputContract: readAgyDataInputContract(command, cwd),
      recordedAt: Date.now(),
    }),
  );
}

export function recordPostToolUseAgyCommand(payload, options = {}) {
  const conversationId = payload?.conversationId;
  if (typeof conversationId !== 'string' || !conversationId || !options.profileHome) return;
  withAgyCommandLedger(options.profileHome, (store) => {
    const entries = store.entries();
    if (!entries.length) return;
    let dirty = hydrateEntriesFromTranscript(entries, payload?.transcriptPath, conversationId);
    const directTaskId = extractTaskIdFromText(
      typeof payload?.output === 'string' ? payload.output : JSON.stringify(payload?.toolResponse ?? ''),
    );
    if (directTaskId) {
      for (const entry of entries) {
        if (
          entry.conversationId === conversationId &&
          ((payload?.toolCall?.id && entry.callId === payload.toolCall.id) ||
            (typeof payload?.stepIdx === 'number' && entry.stepIdx === payload.stepIdx)) &&
          entry.taskId !== directTaskId
        ) {
          entry.taskId = directTaskId;
          dirty = true;
        }
      }
    }
    if (dirty) store.saveBindings(entries);
  });
}

export function resolveBoundCommandTask(payload, taskId, options = {}) {
  const conversationId = payload?.conversationId;
  if (typeof conversationId !== 'string' || !conversationId || typeof taskId !== 'string' || !taskId) {
    return {
      ok: false,
      reason: 'terminal input directory is unverified; start a new run_command instead',
    };
  }
  if (!taskId.startsWith(`${conversationId}/`)) {
    return {
      ok: false,
      reason: 'terminal input directory belongs to a different conversation; start a new run_command instead',
    };
  }
  return (
    withAgyCommandLedger(options.profileHome, (store) => {
      const entries = store.entries();
      if (hydrateEntriesFromTranscript(entries, payload?.transcriptPath, conversationId)) {
        store.saveBindings(entries);
      }
      const match = [...entries]
        .reverse()
        .find((entry) => entry.conversationId === conversationId && entry.taskId === taskId);
      if (!match || typeof match.cwd !== 'string') {
        return {
          ok: false,
          reason:
            'terminal input directory is not bound to an approved task in this conversation; start a new run_command instead',
        };
      }
      const resolvedCwd = kernelPath(match.cwd);
      if (!resolvedCwd) {
        return { ok: false, reason: 'bound terminal input directory is unavailable' };
      }
      const currentContract = readAgyDataInputContract(match.command, resolvedCwd);
      const unchanged =
        currentContract !== null && JSON.stringify(match.dataInputContract) === JSON.stringify(currentContract);
      return {
        ok: true,
        entry: { ...match, cwd: resolvedCwd, dataInputContract: unchanged ? currentContract : null },
      };
    }) ?? { ok: false, reason: 'terminal input directory is not bound to an approved task in this conversation' }
  );
}

export function isPhysicalTargetWithinWorkspace(target, cwd, workspaceRoot) {
  if (typeof target !== 'string' || !target || typeof workspaceRoot !== 'string' || !workspaceRoot) return false;
  const rootPhysical = kernelPath(workspaceRoot);
  if (!rootPhysical) return false;
  const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  let parent = absolute;
  const suffix = [];
  while (!kernelPath(parent) && dirname(parent) !== parent) {
    suffix.unshift(basename(parent));
    parent = dirname(parent);
  }
  const parentKernel = kernelPath(parent);
  if (!parentKernel) return false;
  const physical = join(parentKernel, ...suffix);
  const rel = relative(rootPhysical, physical);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export function requestAgyNativeApproval(payload, verdict, cwd, options = {}, approvedTask) {
  return new Promise((resolveDecision) => {
    const deny = (reason) => resolveDecision({ decision: 'deny', reason: `Clowder AI native guard: ${reason}` });
    try {
      const bridgeFile = options.approvalBridgeFile;
      if (typeof bridgeFile !== 'string' || !bridgeFile || !existsSync(bridgeFile)) {
        return deny('interactive approval bridge is unavailable for request-review tool execution');
      }
      const bridgeStat = lstatSync(bridgeFile);
      if (bridgeStat.isSymbolicLink() || !bridgeStat.isFile()) {
        return deny('interactive approval bridge file is invalid');
      }
      const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8'));
      const url = new URL(String(bridge?.url ?? ''));
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || typeof bridge?.token !== 'string') {
        return deny('interactive approval bridge endpoint is untrusted');
      }
      const body = Buffer.from(
        JSON.stringify({
          token: bridge.token,
          conversationId: payload?.conversationId ?? null,
          stepIdx: payload?.stepIdx ?? null,
          callId: payload?.toolCall?.id ?? null,
          toolName: payload?.toolCall?.name ?? '',
          args: payload?.toolCall?.args ?? {},
          cwd,
          approvedTask,
        }),
        'utf8',
      );
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: Number(url.port),
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.byteLength, Connection: 'close' },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              if (res.statusCode === 200 && parsed?.approved === true) {
                resolveDecision({ decision: 'allow', ...(verdict.overwrite ? { overwrite: verdict.overwrite } : {}) });
              } else {
                deny(
                  typeof parsed?.reason === 'string' && parsed.reason ? parsed.reason : 'tool call declined by user',
                );
              }
            } catch {
              deny('invalid approval bridge response');
            }
          });
        },
      );
      req.on('error', () => deny('approval bridge connection failed'));
      req.write(body);
      req.end();
    } catch {
      deny('could not request interactive tool approval');
    }
  });
}
