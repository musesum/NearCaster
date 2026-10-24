// Mini-app host seam: the Farcaster SDK inside a client, a plain browser page outside one.
import { sdk } from '@farcaster/miniapp-sdk';

export type Insets = { top: number; bottom: number; left: number; right: number };

export type HostUser = {
  fid: number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
};

// declined = the viewer said no; unsigned = the client found no signed manifest for this domain.
export type AddResult = 'added' | 'declined' | 'unsigned';

export type Host = {
  inMiniApp: boolean;
  platform: 'web' | 'mobile' | 'browser';
  user?: HostUser;
  insets: Insets;
  // Inside a client: whether the viewer's app list holds NearCaster; undefined on a plain page.
  added?: boolean;
  ready(): Promise<void>;
  viewProfile(fid: number, username?: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  composeCast(text: string, embeds?: string[]): Promise<void>;
  addApp(): Promise<AddResult>;
  // Adds and removals made from the client's own menu.
  onAdded(cb: (added: boolean) => void): void;
  haptic(): void;
};

const ZERO: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

// After a reload inside a client the context handshake can take seconds (sdk.isInMiniApp() gives it 1 s).
const HANDSHAKE_MS = 5000;

// A plain page short-circuits; a framed one waits up to HANDSHAKE_MS for the client's context.
// sdk.context user fields are host-supplied and untrusted: display only.
export async function connectHost(): Promise<Host> {
  const framed = window.parent !== window || 'ReactNativeWebView' in window;
  if (!framed) return browserHost();
  const ctx = await Promise.race([
    // sdk.context is a comlink proxy: .then is the supported await; .catch would post a function to the host.
    sdk.context.then(
      (c) => c,
      () => undefined,
    ),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HANDSHAKE_MS)),
  ]);
  if (!ctx?.user) {
    // A client that answers after the wait still needs ready() to drop its splash.
    void Promise.resolve(sdk.actions.ready({ disableNativeGestures: true })).catch(() => undefined);
    return browserHost();
  }

  const insets = ctx.client.safeAreaInsets ?? ZERO;
  const hasHaptics = ctx.features?.haptics === true;
  // A client without add support keeps the pill hidden; one that cannot list its capabilities is trusted.
  const canAdd = await Promise.race([
    sdk.getCapabilities().then(
      (c) => c.includes('actions.addMiniApp'),
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1000)),
  ]);
  return {
    inMiniApp: true,
    platform: ctx.client.platformType ?? 'web',
    user: {
      fid: ctx.user.fid,
      username: ctx.user.username,
      displayName: ctx.user.displayName,
      pfpUrl: ctx.user.pfpUrl,
    },
    insets,
    added: canAdd ? ctx.client.added === true : undefined,
    // Graph drag and pinch conflict with the client's swipe-to-dismiss.
    ready: () => sdk.actions.ready({ disableNativeGestures: true }),
    viewProfile: (fid) => sdk.actions.viewProfile({ fid }),
    openUrl: (url) => sdk.actions.openUrl(url),
    composeCast: async (text, embeds) => {
      await sdk.actions.composeCast({ text, embeds: embedsTuple(embeds) });
    },
    addApp: () => sdk.actions.addMiniApp().then(() => 'added', addRejection),
    onAdded: (cb) => {
      sdk.on('miniAppAdded', () => cb(true));
      sdk.on('miniAppRemoved', () => cb(false));
    },
    haptic: () => {
      if (hasHaptics) void sdk.haptics.selectionChanged().catch(() => undefined);
    },
  };
}

// The SDK's two refusals become results; anything else stays an error.
function addRejection(e: unknown): AddResult {
  const name = (e as Error | undefined)?.name;
  if (name === 'AddMiniApp.RejectedByUser') return 'declined';
  if (name === 'AddMiniApp.InvalidDomainManifest') return 'unsigned';
  throw e;
}

function browserHost(): Host {
  return {
    inMiniApp: false,
    platform: 'browser',
    insets: ZERO,
    ready: async () => undefined,
    viewProfile: async (fid, username) => {
      const path = username && !username.startsWith('fid:') ? encodeURIComponent(username) : `~/profiles/${fid}`;
      window.open(`https://farcaster.xyz/${path}`, '_blank', 'noopener');
    },
    openUrl: async (url) => {
      window.open(url, '_blank', 'noopener');
    },
    composeCast: async (text, embeds) => {
      const q = new URLSearchParams({ text });
      for (const e of embeds ?? []) q.append('embeds[]', e);
      window.open(`https://farcaster.xyz/~/compose?${q}`, '_blank', 'noopener');
    },
    addApp: () => Promise.reject(new Error('Adding needs a Farcaster client')),
    onAdded: () => undefined,
    haptic: () => undefined,
  };
}

// composeCast takes at most two embeds as a tuple.
function embedsTuple(embeds?: string[]): [] | [string] | [string, string] | undefined {
  if (!embeds || embeds.length === 0) return undefined;
  if (embeds.length === 1) return [embeds[0]];
  return [embeds[0], embeds[1]];
}
