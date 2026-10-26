import { sgnlog } from './util.js';

// What the Professor's brain looks at, in plain words (shown on the dashboard).
export const FEATURE_NAMES = [
  'Unique buyers', 'Buy/sell balance', 'Net SOL flowing in', 'Money flow last 30s', 'Flow speeding up',
  'Bonding curve progress', 'Price growth since launch', 'Drop from peak', 'Biggest wallet share',
  'Creator still holding', 'Creator sold', 'Sniper share at launch', 'Trading speed', 'Coin age', 'X / social strength',
];

export function vectorize(f, social) {
  return [
    Math.log1p(f.buyers), Math.log1p(f.ratio), sgnlog(f.netFlow), sgnlog(f.vel), sgnlog(f.accel),
    f.progress, Math.log(Math.max(f.growth, 1e-6)), f.drawdown, f.topHolderPct * 10,
    f.creatorPct * 10, f.creatorSold ? 1 : 0, f.sniperPct * 10, Math.log1p(f.tradeRate), Math.log1p(f.age / 60), social,
  ];
}

/**
 * Online logistic regression: learns after every finished (real or shadow) trade
 * whether a coin with these features made money. Features are standardized on the fly.
 */
export class Learner {
  constructor(dim, saved) {
    const ok = saved && Array.isArray(saved.w) && saved.w.length === dim;
    this.dim = dim;
    this.w = ok ? saved.w : Array(dim).fill(0);
    this.b = ok ? saved.b : 0;
    this.n = ok ? saved.n : 0;
    this.mean = ok ? saved.mean : Array(dim).fill(0);
    this.m2 = ok ? saved.m2 : Array(dim).fill(0);
    this.recent = ok ? saved.recent || [] : [];
    this.lr = 0.04;
    this.l2 = 0.002;
  }
  norm(x) {
    return x.map((v, i) => {
      const sd = this.n > 1 ? Math.sqrt(this.m2[i] / (this.n - 1)) : 1;
      return (v - this.mean[i]) / (sd > 1e-9 ? sd : 1);
    });
  }
  raw(x) {
    const z = this.norm(x);
    let s = this.b;
    for (let i = 0; i < this.dim; i++) s += this.w[i] * z[i];
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
  }
  /** Blend with the hand-written rule until there is enough experience. */
  predict(x, heuristic) {
    const trust = Math.min(1, this.n / 150);
    return trust * this.raw(x) + (1 - trust) * heuristic;
  }
  learn(x, y) {
    const p = this.raw(x); // scored before learning = honest out-of-sample accuracy
    this.recent.push([+(p.toFixed(3)), y]);
    if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
    this.n++;
    for (let i = 0; i < this.dim; i++) {
      const d = x[i] - this.mean[i];
      this.mean[i] += d / this.n;
      this.m2[i] += d * (x[i] - this.mean[i]);
    }
    const z = this.norm(x), g = p - y;
    for (let i = 0; i < this.dim; i++) this.w[i] -= this.lr * (g * z[i] + this.l2 * this.w[i]);
    this.b -= this.lr * g;
  }
  accuracy(last = 100) {
    const r = this.recent.slice(-last);
    if (!r.length) return null;
    return r.filter(([p, y]) => (p >= 0.5 ? 1 : 0) === y).length / r.length;
  }
  factors() {
    return FEATURE_NAMES.map((name, i) => ({ name, weight: +this.w[i].toFixed(3) }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  }
  toJSON() { return { w: this.w, b: this.b, n: this.n, mean: this.mean, m2: this.m2, recent: this.recent }; }
}
