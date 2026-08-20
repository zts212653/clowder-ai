export interface SignalIngressTrace {
  readonly at: number;
  readonly pluginInstanceId: string;
  readonly signalType?: string;
  readonly outcome: 'accepted' | 'duplicate' | 'rejected';
  readonly rejectionCode?: string;
}

/** Payload-free, bounded-retention diagnostics sink. Never intake truth. */
export interface SignalIngressTraceSink {
  record(trace: SignalIngressTrace): Promise<void> | void;
}

export class MemorySignalIngressTraceSink implements SignalIngressTraceSink {
  readonly traces: SignalIngressTrace[] = [];

  record(trace: SignalIngressTrace): void {
    this.traces.push(structuredClone(trace));
  }
}
