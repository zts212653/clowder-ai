import path from 'node:path';
import { timingEnvironment, writeTimingReport } from './report-format.mjs';

function isFileWrapper(data) {
  if (typeof data?.name !== 'string' || typeof data.file !== 'string') return false;
  return data.name === data.file || path.resolve(data.name) === path.resolve(data.file);
}

function observeEvent(files, event) {
  const data = event?.data;
  const details = data?.details || {};
  const testType = details.type ?? data?.type;
  if (!data || data.nesting !== 0 || testType !== 'test' || !data.file || !isFileWrapper(data)) return;
  if (!['test:complete', 'test:pass', 'test:fail'].includes(event.type)) return;
  const durationMs = Number(details.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const status =
    event.type === 'test:fail' || details.passed === false ? 'failed' : details.passed === true ? 'passed' : 'unknown';
  const previous = files.get(data.file);
  if (!previous || status !== 'unknown' || previous.status === 'unknown') {
    files.set(data.file, { file: data.file, durationMs, status });
  }
}

/**
 * Node's reporter API is an event stream. The gate installs this reporter as
 * a second reporter beside the built-in spec reporter, so this stream remains
 * deliberately silent and only writes the sidecar.
 */
export default async function* nodeFileTimingReporter(source) {
  const files = new Map();
  for await (const event of source) {
    observeEvent(files, event);
  }
  if (timingEnvironment()) {
    try {
      writeTimingReport({ runner: 'node:test', files: [...files.values()] });
    } catch (error) {
      process.stderr.write(`[test-file-timing] unable to write Node report: ${error.message}\n`);
    }
  }
  yield '';
}

export { observeEvent };
