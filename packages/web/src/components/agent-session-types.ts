export interface AgentSessionSnapshot {
  daemonShortId: string;
  state: string;
  detail?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
}
