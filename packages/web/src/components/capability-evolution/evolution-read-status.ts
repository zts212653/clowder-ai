export type EvolutionReadStatus = 'loading' | 'resolved' | 'unavailable';

/** An absent response cannot establish an empty owner collection. */
export function pendingOwnerRead(status: EvolutionReadStatus, subject: string): string {
  return status === 'loading' ? `正在读取${subject}…` : `暂时无法确认${subject}。`;
}
