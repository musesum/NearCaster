// Scrub preview: a small card above the finger naming the node under it and how it reaches the ego.
import type { EgoGraph, GNode } from '../data/types.ts';

const RING = ['You', 'Your circle', 'Friend of a friend', 'Further out'];
// What is known of a circle account's follows with you; an unread direction says nothing.
const circleText = (n: GNode) => (n.egoFollows && n.followsEgo ? 'You follow each other' : n.egoFollows ? 'You follow' : n.followsEgo ? 'Follows you' : RING[1]);
// Clearance above the fingertip so the finger never covers the card.
const LIFT = 56;

export class Peek {
  private el: HTMLElement;
  private stage: HTMLElement;
  // Followers per node from hop 1 (your circle), rebuilt when the graph or its link count changes.
  private viaFor?: { graph: EgoGraph; links: number; via: Map<string, number> };

  constructor(el: HTMLElement, stage: HTMLElement) {
    this.el = el;
    this.stage = stage;
  }

  show(node: GNode, graph: EgoGraph, color: (c: number) => string, at: [number, number]): void {
    const dot = document.createElement('i');
    dot.style.background = color(node.community);
    const who = document.createElement('div');
    who.className = 'who';
    who.append(dot, node.displayName || node.username);
    const sub = document.createElement('div');
    sub.className = 'sub';
    const handle = node.username.startsWith('fid:') ? `fid ${node.fid}` : `@${node.username}`;
    const via = this.via(graph).get(node.id) ?? 0;
    const ring = node.hop === 1 ? circleText(node) : node.hop === 0 ? RING[0] : `${RING[node.hop]} · ${via} in your circle`;
    sub.textContent = `${handle} · ${ring}`;
    this.el.replaceChildren(who, sub);
    this.el.hidden = false;

    const s = this.stage.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const x = Math.max(8, Math.min(s.width - w - 8, at[0] - s.left - w / 2));
    const above = at[1] - s.top - LIFT - h;
    const y = above >= 8 ? above : Math.min(s.height - h - 8, at[1] - s.top + LIFT);
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  hide(): void {
    this.el.hidden = true;
  }

  private via(graph: EgoGraph): Map<string, number> {
    if (this.viaFor?.graph === graph && this.viaFor.links === graph.links.length) return this.viaFor.via;
    const hop = new Map(graph.nodes.map((n) => [n.id, n.hop]));
    const via = new Map<string, number>();
    const add = (from: string, to: string) => {
      if (hop.get(from) === 1 && from !== to) via.set(to, (via.get(to) ?? 0) + 1);
    };
    for (const l of graph.links) {
      add(l.source, l.target);
      if (l.kind === 'mutual') add(l.target, l.source);
    }
    this.viaFor = { graph, links: graph.links.length, via };
    return via;
  }
}
