// Plain JS controls keep a TypeScript loader's background work out of this experiment.
const originalCpuUsage = process.cpuUsage.bind(process);
let processCpuCalls = 0;
process.cpuUsage = (previous) => {
  ++processCpuCalls;
  return originalCpuUsage(previous);
};

export function processCpuCallCount() {
  return processCpuCalls;
}

export async function waiting(input) {
  await new Promise((resolve) => setTimeout(resolve, input.milliseconds));
  return { id: input.id };
}

export function burnProcessCpu(input) {
  const began = process.cpuUsage();
  while (true) {
    const used = process.cpuUsage(began);
    if (used.user + used.system >= input.cpuMs * 1000) break;
  }
  return { id: input.id };
}

export function breakCpuProbe() {
  process.cpuUsage = () => {
    throw new Error('private CPU probe failure');
  };
  return 'probe-fault-result';
}

export function fail() {
  throw new Error('fixture failure');
}
