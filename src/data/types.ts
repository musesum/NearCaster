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
  // The fid registered to a username (fname or ENS name); undefined when no account has it.
  fidByName(name: string): Promise<number | undefined>;
}

// hop 0 = ego, 1 = your circle (ego follows it or it follows ego), 2 = friend of a friend, 3 = reached by expanding a hop-2 node.
export type Hop = 0 | 1 | 2 | 3;

export type GNode = User & {
  id: string;
  hop: Hop;
  // Follow direction between this node and the ego; undefined = the list that would show it was not read in full.
  egoFollows?: boolean;
  followsEgo?: boolean;
  // Number of hop-1 accounts following this node (friend-of-friend support).
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
  // kind 'follow' (source follows target): true when the return follow is known absent, false when it was never read.
  oneWay: boolean;
};

export type EgoGraph = {
  egoId: string;
  nodes: GNode[];
  links: GLink[];
  provider: string;
  // Caps that cut the crawl, for the status caption.
  truncated: string[];
};

// How a node and the ego follow each other; 'unread' when either direction was not read.
export type EgoTie = 'mutual' | 'you-follow' | 'follows-you' | 'none' | 'unread';
export const egoTie = (n: Pick<GNode, 'egoFollows' | 'followsEgo'>): EgoTie =>
  n.egoFollows === undefined || n.followsEgo === undefined
    ? 'unread'
    : n.egoFollows
      ? n.followsEgo
        ? 'mutual'
        : 'you-follow'
      : n.followsEgo
        ? 'follows-you'
        : 'none';

export const idOf = (fid: number): string => `f${fid}`;
export const fidOf = (id: string): number => Number(id.slice(1));
