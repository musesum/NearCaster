// Profile panel (Vizster's profile view): who this is, how they connect to the ego, actions.
import type { EgoGraph, GNode } from '../data/types.ts';
import { nearYou } from './near.ts';

export type PanelActions = {
  focus(id: string): void;
  select(node: GNode): void;
  pinned(id: string): boolean;
  unpin(id: string): void;
  viewProfile(node: GNode): void;
  expand(node: GNode): Promise<void>;
  recenter(node: GNode): void;
  cast(node: GNode): void;
  close(): void;
};

const HOP_TEXT = ['You', 'Your circle', 'Friend of a friend', 'Further out'];

export class Panel {
  private el: HTMLElement;
  private actions: PanelActions;
  private shown?: string;
  private preview = false;
  // The arrow row under the bio: open shows the stats, circle chips and actions, and stays open for later profiles.
  private details = false;
  private expanding?: string;

  constructor(el: HTMLElement, actions: PanelActions) {
    this.el = el;
    this.actions = actions;
  }

  get openId(): string | undefined {
    return this.shown;
  }

  // A tap opens the details; the arrow row can still shut them.
  openDetails(): void {
    this.details = true;
  }

  get previewing(): boolean {
    return this.preview;
  }

  hide(): void {
    this.el.hidden = true;
    this.el.classList.remove('preview');
    this.shown = undefined;
    this.preview = false;
  }

  // A preview (hover, finger browse) shows only the picture, names and bio above a shut arrow row.
  show(node: GNode, graph: EgoGraph, communityColor: (c: number) => string, preview = false): void {
    this.shown = node.id;
    this.preview = preview;
    const open = this.details && !preview;
    const el = this.el;
    el.replaceChildren();
    el.classList.toggle('preview', preview);
    el.hidden = false;

    if (!preview) {
      const close = button('×', 'close', () => this.actions.close());
      close.setAttribute('aria-label', 'Close profile');
      el.append(close);
    }

    const head = div('head');
    if (node.pfpUrl) {
      const img = document.createElement('img');
      img.src = node.pfpUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      head.append(img);
    } else {
      const ph = div('ph');
      ph.style.background = communityColor(node.community);
      head.append(ph);
    }
    const names = div('');
    names.append(text('div', 'name', node.displayName || node.username), text('div', 'user', node.username.startsWith('fid:') ? `fid ${node.fid}` : `@${node.username} · fid ${node.fid}`));
    head.append(names);
    el.append(head);

    if (node.bio) el.append(text('div', 'bio', node.bio));

    // A preview's arrow selects the account with its details open.
    const more = button('', 'more', () => {
      this.details = !open;
      if (preview) this.actions.select(node);
      else this.show(node, graph, communityColor);
      this.el.querySelector<HTMLElement>('.more')?.focus();
    });
    more.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-label', open ? 'Hide details' : 'Show details');
    more.append(document.createElement('i'));
    el.append(more);
    if (!open) return;

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const ins: GNode[] = [];
    const outs: GNode[] = [];
    for (const l of graph.links) {
      if (l.target === node.id) {
        const o = byId.get(l.source);
        if (o) ins.push(o);
        if (l.kind === 'mutual' && o) outs.push(o);
      } else if (l.source === node.id) {
        const o = byId.get(l.target);
        if (o) outs.push(o);
        if (l.kind === 'mutual' && o) ins.push(o);
      }
    }
    const friendsIn = ins.filter((n) => n.hop === 1 && n.id !== node.id);

    const stats = div('stats');
    const stat = (k: string, v: string | number | undefined) => {
      if (v === undefined) return;
      const s = document.createElement('div');
      s.append(`${k} `);
      const b = document.createElement('b');
      b.textContent = String(v);
      s.append(b);
      stats.append(s);
    };
    stat('Followers', node.followerCount?.toLocaleString());
    stat('Following', node.followingCount?.toLocaleString());
    stat('Ring', HOP_TEXT[node.hop]);
    stat('Community', node.community >= 0 ? `#${node.community + 1}` : '—');
    if (node.hop > 0) {
      const said = (v?: boolean) => (v === undefined ? 'not read' : v ? 'yes' : 'no');
      stat('You follow', said(node.egoFollows));
      stat('Follows you', said(node.followsEgo));
    }
    stat('Links here', ins.length + outs.length);
    el.append(stats);

    if (friendsIn.length) {
      const n = friendsIn.length;
      el.append(text('h4', '', node.hop === 0 ? `${n} in your circle follow you` : node.hop === 1 ? `Also followed by ${n} in your circle` : `Followed by ${n} in your circle`));
      const chips = div('chips');
      for (const f of friendsIn.sort((a, b) => (b.followerCount ?? 0) - (a.followerCount ?? 0)).slice(0, 12)) {
        chips.append(button(f.displayName || f.username, 'chip', () => this.actions.focus(f.id)));
      }
      el.append(chips);
    }

    // The ego's panel lists who is near: friends of friends, ranked by how many in your circle follow them.
    if (node.hop === 0) {
      const picks = nearYou(graph);
      if (picks.length) {
        el.append(text('h4', '', 'Near you: followed by your circle'));
        const chips = div('chips');
        for (const p of picks) chips.append(button(`${p.node.displayName || p.node.username} · ${p.via.length}`, 'chip', () => this.actions.focus(p.node.id)));
        el.append(chips);
      }
    }

    const acts = div('actions');
    acts.append(button('View profile', 'primary', () => this.actions.viewProfile(node)));
    if (!node.expanded) {
      // A redraw during the expand (a hover ending) keeps the busy state.
      const busy = this.expanding === node.id;
      const ex = button(busy ? 'Expanding…' : 'Expand', 'expand', async () => {
        this.expanding = node.id;
        ex.disabled = true;
        ex.textContent = 'Expanding…';
        try {
          await this.actions.expand(node);
        } finally {
          this.expanding = undefined;
          const now = this.el.querySelector<HTMLButtonElement>('button.expand');
          if (now) {
            now.disabled = false;
            now.textContent = 'Expand';
          }
        }
      });
      ex.disabled = busy;
      acts.append(ex);
    }
    if (node.hop > 0) acts.append(button('Center here', '', () => this.actions.recenter(node)));
    if (node.hop > 0 && this.actions.pinned(node.id)) {
      acts.append(
        button('Unpin', '', () => {
          this.actions.unpin(node.id);
          this.show(node, graph, communityColor);
        }),
      );
    }
    acts.append(button('Cast', '', () => this.actions.cast(node)));
    el.append(acts);
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  return d;
}

function text(tag: string, cls: string, value: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = value;
  return e;
}

function button(label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}
