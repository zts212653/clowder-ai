// Provider/socket transport boundary only. The real history, stores and UI remain mounted.
export function useSocket() {
  return { socketConnected: true };
}
