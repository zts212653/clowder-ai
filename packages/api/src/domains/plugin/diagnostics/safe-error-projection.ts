/**
 * F202 W2-6b — a bounded view of an error that is safe to write to the Host log.
 *
 * What a plugin, or an SDK it uses, throws can carry anything, and no pattern proves a piece of free
 * text holds no credential: a password needs no "=", a token needs no digit, and V8 copies the whole
 * message into the stack. So no free text is kept — not the message, not the text of a stack line.
 * Kept is only what the Host can vouch for, or what has a shape a credential does not take:
 * - where the error comes from: the Host's own refusal (with the capability), another Host error
 *   (with its closed-set code), or unverified;
 * - a conventional error class name, a Node system or `ERR_` code, an integer code, an HTTP status;
 * - code locations (file:line:column) read from a stack whose header is exactly the error's own, so
 *   no line of the message can pass for a frame; only a bounded prefix of the stack is scanned.
 * Causes and aggregated errors get the same treatment, within fixed bounds. A property that throws
 * when read counts as absent.
 */
export type SafeErrorOrigin = 'host_refusal' | 'host' | 'unverified';

export interface SafeErrorProjection {
  readonly origin: SafeErrorOrigin;
  readonly type?: string;
  readonly code?: string | number;
  readonly capability?: string;
  readonly status?: number;
  readonly at?: readonly string[];
  readonly cause?: SafeErrorProjection;
  readonly errors?: readonly SafeErrorProjection[];
}

/** How the caller, which knows the Host's own errors, recognizes one. */
export interface HostErrorRecognition {
  /** The refused capability, when this very object is a registered Host refusal. */
  readonly refusal: (error: object) => string | undefined;
  /** The closed-set code, when this very object is a Host error. */
  readonly hostCode: (error: object) => string | undefined;
}

const MAX_DEPTH = 4;
const MAX_ERRORS = 16;
const MAX_AGGREGATED = 5;
const MAX_FRAMES = 8;
const MAX_STACK_SCAN = 16_384;
const MAX_STACK_LINES = 64;

const CONVENTIONAL_TYPE = /^(?:[A-Z][A-Za-z0-9]{0,40})?(?:Error|Exception)$/u;
const SYSTEM_CODE = /^(?:E[A-Z_]{2,24}|ERR_[A-Z_]{2,60})$/u;
const FRAME_PREFIX = '    at ';
const LOCATION = /^(?:.*? \()?((?:file:\/\/|\/|node:)[^()]*?):(\d+):(\d+)\)?$/u;
const UNREADABLE = Symbol('unreadable');

const NO_RECOGNITION: HostErrorRecognition = { refusal: () => undefined, hostCode: () => undefined };

function read(target: object, key: string): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return UNREADABLE;
  }
}

function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

/** What V8 writes as the first part of the stack: `Error.prototype.toString` of the error. */
function stackHeader(error: object): string | undefined {
  const name = read(error, 'name');
  const message = read(error, 'message');
  const shownName = name === undefined ? 'Error' : name;
  const shownMessage = message === undefined ? '' : message;
  if (typeof shownName !== 'string' || typeof shownMessage !== 'string') return undefined;
  if (shownMessage === '') return shownName;
  return shownName === '' ? shownMessage : `${shownName}: ${shownMessage}`;
}

/** The code locations of the stack's frames, when the stack verifiably starts with the error's own header. */
function locations(error: object): readonly string[] | undefined {
  const stack = read(error, 'stack');
  const header = stackHeader(error);
  if (typeof stack !== 'string' || header === undefined || header.length > MAX_STACK_SCAN) return undefined;
  const scanned = stack.slice(0, MAX_STACK_SCAN);
  if (!scanned.startsWith(header)) return undefined;
  const lines = scanned.slice(header.length).split('\n', MAX_STACK_LINES);
  if (lines[0] !== '') return undefined;
  // A line the scan bound cut through is not a whole frame.
  const complete = scanned.length < stack.length ? lines.slice(1, -1) : lines.slice(1);
  const found: string[] = [];
  for (const line of complete) {
    if (!line.startsWith(FRAME_PREFIX)) break;
    const match = LOCATION.exec(line.slice(FRAME_PREFIX.length));
    if (match) found.push(`${match[1].split(/[?#]/u, 1)[0]}:${match[2]}:${match[3]}`);
    if (found.length === MAX_FRAMES) break;
  }
  return found.length > 0 ? found : undefined;
}

function conventionalType(error: object): string | undefined {
  const name = read(error, 'name');
  return typeof name === 'string' && CONVENTIONAL_TYPE.test(name) ? name : undefined;
}

function conventionalCode(error: object): string | number | undefined {
  const code = read(error, 'code');
  if (typeof code === 'number') return Number.isSafeInteger(code) ? code : undefined;
  return typeof code === 'string' && SYSTEM_CODE.test(code) ? code : undefined;
}

function httpStatus(error: object): number | undefined {
  const response = read(error, 'response');
  const nested = typeof response === 'object' && response !== null ? read(response, 'status') : undefined;
  for (const candidate of [read(error, 'status'), read(error, 'statusCode'), nested]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

function causeOf(error: object): unknown {
  if (!attempt(() => 'cause' in error)) return undefined;
  const cause = read(error, 'cause');
  return cause === UNREADABLE ? undefined : cause;
}

/** What an `AggregateError` collected (a failed start that also failed to roll back reports both). */
function aggregated(error: object): readonly unknown[] {
  return (
    attempt(() => {
      if (!(error instanceof AggregateError)) return [];
      const errors: unknown = error.errors;
      return Array.isArray(errors) ? errors.slice(0, MAX_AGGREGATED) : [];
    }) ?? []
  );
}

interface Walk {
  remaining: number;
  readonly inspected: Set<object>;
  readonly recognition: HostErrorRecognition;
}

function recognize(error: object, recognition: HostErrorRecognition) {
  const capability = attempt(() => recognition.refusal(error));
  const hostCode = attempt(() => recognition.hostCode(error));
  const origin: SafeErrorOrigin =
    capability !== undefined ? 'host_refusal' : hostCode !== undefined ? 'host' : 'unverified';
  return { origin, capability, hostCode };
}

function nested(error: object, depth: number, walk: Walk) {
  if (depth >= MAX_DEPTH) return {};
  const rawCause = causeOf(error);
  const cause = rawCause === undefined ? undefined : project(rawCause, depth + 1, walk);
  const errors = aggregated(error)
    .map((entry) => project(entry, depth + 1, walk))
    .filter((entry): entry is SafeErrorProjection => entry !== undefined);
  return { cause, errors: errors.length === 0 ? undefined : errors };
}

/** The projection without its absent fields, so the log line shows only what is known. */
function present(projection: SafeErrorProjection): SafeErrorProjection {
  return Object.fromEntries(
    Object.entries(projection).filter(([, value]) => value !== undefined),
  ) as unknown as SafeErrorProjection;
}

function project(value: unknown, depth: number, walk: Walk): SafeErrorProjection | undefined {
  if (walk.remaining <= 0) return undefined;
  walk.remaining -= 1;
  if (typeof value !== 'object' || value === null) {
    return { origin: 'unverified', type: value === null ? 'null' : typeof value };
  }
  if (walk.inspected.has(value)) return undefined;
  walk.inspected.add(value);
  const { origin, capability, hostCode } = recognize(value, walk.recognition);
  return present({
    origin,
    type: conventionalType(value),
    code: hostCode ?? conventionalCode(value),
    capability,
    status: origin === 'unverified' ? httpStatus(value) : undefined,
    at: locations(value),
    ...nested(value, depth, walk),
  });
}

export function safeErrorProjection(
  error: unknown,
  recognition: HostErrorRecognition = NO_RECOGNITION,
): SafeErrorProjection {
  return project(error, 0, { remaining: MAX_ERRORS, inspected: new Set(), recognition }) ?? { origin: 'unverified' };
}
