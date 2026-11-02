export function macProcessEnvironmentCommand(options: {
  pids?: readonly number[];
  markers: readonly string[];
  retainEnvironmentKeys?: readonly string[];
}): {
  file: string;
  args: string[];
};
