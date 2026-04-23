export const ExternalProjectKeys = {
  detail: (id: string) => `external:project:${id}`,
  userList: (userId: string) => `external:projects:user:${userId}`,
} as const;
