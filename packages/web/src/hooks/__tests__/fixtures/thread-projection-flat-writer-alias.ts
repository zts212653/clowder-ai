declare function getThreadProjectionWriter(): {
  addMessage(message: unknown): void;
};

const { addMessage: add } = getThreadProjectionWriter();

export async function completeAfterThreadSwitch(message: unknown): Promise<void> {
  await Promise.resolve();
  add(message);
}
