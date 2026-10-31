export const LabelKeys = {
  detail: (id: string) => `label:${id}`,
  userList: (userId: string) => `labels:user:${userId}`,
} as const;
