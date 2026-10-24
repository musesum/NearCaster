// Social-graph data contracts shared by providers, crawl, and view.

export type User = {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl?: string;
  followerCount?: number;
  followingCount?: number;
  bio?: string;
};

export type Page = { fids: number[]; next?: string };

export interface DataProvider {
  readonly name: string;
  // One page of fids the account follows.
  following(fid: number, cursor?: string): Promise<Page>;
  // One page of fids following the account.
  followers(fid: number, cursor?: string): Promise<Page>;
  // Profiles for a batch of fids; missing fids are omitted.
  users(fids: number[]): Promise<User[]>;
}

// hop 0 = ego, 1 = followed by ego, 2 = friend of a friend, 3 = reached by expanding a hop-2 node.
export type Hop = 0 | 1 | 2 | 3;

export type GNode = User & {
  id: string;
  hop: Hop;
  // Ego follows this node and it follows ego back.
  mutualWithEgo: boolean;
  // Number of hop-1 friends linking to this node (friend-of-friend support).
  support: number;
  community: number;
  // Fetched outgoing follows; a node whose list was fetched is "expanded".
  expanded: boolean;
};

export type LinkKind = 'follow' | 'mutual';

export type GLink = {
  source: string;
  target: string;
  kind: LinkKind;
};

export type EgoGraph = {
  egoId: string;
  nodes: GNode[];
  links: GLink[];
  provider: string;
  // Caps that cut the crawl, for the status caption.
  truncated: string[];
};

export const idOf = (fid: number): string => `f${fid}`;
export const fidOf = (id: string): number => Number(id.slice(1));
