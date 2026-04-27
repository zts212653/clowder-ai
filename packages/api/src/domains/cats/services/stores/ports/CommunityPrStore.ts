export interface CommunityPrItem {
  id: string;
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  state: 'open' | 'merged' | 'closed';
  replyState: 'unreplied' | 'replied' | 'has-new-activity';
  headSha: string;
  lastReviewedSha: string | null;
  draft: boolean;
  updatedAt: number;
  createdAt: number;
}

export interface CreateCommunityPrInput {
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  state: 'open' | 'merged' | 'closed';
  replyState: 'unreplied' | 'replied' | 'has-new-activity';
  headSha: string;
  draft: boolean;
}

export type UpdateCommunityPrInput = Partial<
  Pick<CommunityPrItem, 'title' | 'state' | 'replyState' | 'headSha' | 'lastReviewedSha' | 'draft'>
>;

export interface ICommunityPrStore {
  create(input: CreateCommunityPrInput): Promise<CommunityPrItem | null>;
  get(id: string): Promise<CommunityPrItem | null>;
  getByRepoAndNumber(repo: string, prNumber: number): Promise<CommunityPrItem | null>;
  listByRepo(repo: string): Promise<CommunityPrItem[]>;
  listAll(): Promise<CommunityPrItem[]>;
  update(id: string, input: UpdateCommunityPrInput): Promise<CommunityPrItem | null>;
  delete(id: string): Promise<boolean>;
}
