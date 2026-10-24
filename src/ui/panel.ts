// Profile panel (Vizster's profile view): who this is, how they connect to the ego, actions.
import type { EgoGraph, GNode } from '../data/types.ts';
import { nearYou } from './near.ts';

export type PanelActions = {
  focus(id: string): void;
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

  constructor(el: HTMLElement, actions: PanelActions) {
    this.el = el;
    this.actions = actions;
  }

  get openId(): string | undefined {
    return this.shown;
  }

  hide(): void {
    this.el.hidden = true;
    this.shown = undefined;
  }

  show(node: GNode, graph: EgoGraph, communityColor: (c: number) => string): void {
    this.shown = node.id;
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
    const el = this.el;
    el.replaceChildren();

    const close = button('×', 'close', () => this.actions.close());
    close.setAttribute('aria-label', 'Close profile');
    el.append(close);

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
      const ex = button('Expand', '', async () => {
        ex.disabled = true;
        ex.textContent = 'Expanding…';
        try {
          await this.actions.expand(node);
        } finally {
          ex.disabled = false;
          ex.textContent = 'Expand';
        }
      });
      acts.append(ex);
    }
    if (node.hop > 0) acts.append(button('Center here', '', () => this.actions.recenter(node)));
    acts.append(button('Cast', '', () => this.actions.cast(node)));
    el.append(acts);
    el.hidden = false;
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
