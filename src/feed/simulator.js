import { EventEmitter } from 'node:events';
import { buyQuote, sellQuote, INIT_VSOL, INIT_VTOK, TOTAL_SUPPLY, COMPLETE_VSOL } from '../curve.js';

// A fake pump.fun that speaks the same message format as PumpPortal.
// Used for local testing (SIMULATE=true). Coins follow four life stories:
// dud (dies quietly), rug (creator dumps), slow (drifts down), pump (real run).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const rid = (n) => Array.from({ length: n }, () => B58[(Math.random() * 58) | 0]).join('');
const pick = (a) => a[(Math.random() * a.length) | 0];
const rnd = (a, b) => a + Math.random() * (b - a);
const WORDS = ['PEPE', 'DOGE', 'CAT', 'FROG', 'MOON', 'WIF', 'BONK', 'GIGA', 'CHAD', 'GOAT', 'AI', 'BABY', 'KING', 'SHIBA', 'PUMP', 'BASED', 'TURBO', 'NEIRO', 'MOCHI', 'HAMSTER'];
const SUFFIX = ['', '2', 'INU', 'AI', 'X', 'COIN', 'SOL', 'ZILLA'];
const poisson = (l) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= Math.random(); } while (p > L); return k - 1; };

export class SimFeed extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.status = 'simulated';
    this.coins = new Map();
    this.subs = new Set();
    this.reused = ['memelord_sol', 'pumpking', 'cto_daily'];
  }
  start() {
    this.emit('status', 'simulated');
    for (let i = 0; i < 3; i++) this.spawn();
    setInterval(() => this.spawn(), this.cfg.simSpawnMs);
    setInterval(() => this.step(), 500);
  }
  subscribe(m) { m.forEach((x) => this.subs.add(x)); }
  unsubscribe(m) { m.forEach((x) => this.subs.delete(x)); }
  getMeta(mint) { return this.coins.get(mint)?.meta || null; }

  spawn() {
    const r = Math.random();
    const kind = r < 0.42 ? 'dud' : r < 0.62 ? 'rug' : r < 0.8 ? 'fakeout' : r < 0.9 ? 'slow' : 'pump';
    const sym = pick(WORDS) + pick(SUFFIX);
    const mint = rid(40) + 'pump';
    const creator = rid(44);
    let vSol = INIT_VSOL, vTok = INIT_VTOK;
    const init = rnd(0.3, kind === 'rug' ? 3.5 : 1.5);
    const tok = buyQuote(vSol, vTok, init, 0.01);
    vSol += init * 0.99; vTok -= tok;
    const good = kind === 'pump' ? 0.75 : kind === 'fakeout' ? 0.6 : kind === 'slow' ? 0.5 : kind === 'rug' ? 0.55 : 0.25;
    const meta = {
      description: Math.random() < good ? `${sym} is the community coin for ${pick(['frogs', 'cats', 'builders', 'degens', 'AI agents'])} on Solana.` : Math.random() < 0.4 ? '100x guaranteed, presale now, dont miss' : '',
      twitter: Math.random() < good ? (kind === 'rug' && Math.random() < 0.6 ? `https://x.com/${pick(this.reused)}` : `https://x.com/${sym.toLowerCase()}_${rid(3)}`) : '',
      telegram: Math.random() < good * 0.8 ? `https://t.me/${sym.toLowerCase()}` : '',
      website: Math.random() < good * 0.6 ? `https://${sym.toLowerCase()}.fun` : '',
    };
    const c = {
      mint, sym, kind, creator, vSol, vTok, born: Date.now(), bal: new Map([[creator, tok]]), holders: [], meta,
      life: kind === 'fakeout' ? rnd(120, 240) : kind === 'dud' ? rnd(50, 120) : kind === 'rug' ? rnd(90, 200) : kind === 'pump' ? rnd(240, 480) : rnd(180, 360),
      rugAt: rnd(15, 90), fadeAt: rnd(15, 55), bundle: kind === 'rug' && Math.random() < 0.5, dead: false, migrated: false,
    };
    this.coins.set(mint, c);
    this.emit('create', {
      signature: rid(64), mint, traderPublicKey: creator, txType: 'create', initialBuy: tok, solAmount: init,
      vSolInBondingCurve: vSol, vTokensInBondingCurve: vTok, marketCapSol: (vSol / vTok) * TOTAL_SUPPLY,
      name: `${sym} ${pick(['Coin', 'Token', 'on Sol', ''])}`.trim(), symbol: sym, uri: 'sim:' + mint, pool: 'pump',
    });
    if (this.coins.size > 700) for (const [k, v] of this.coins) { if (v.dead) { this.coins.delete(k); if (this.coins.size <= 600) break; } }
  }

  behavior(c, age) {
    switch (c.kind) {
      case 'dud': return { rate: age < 20 ? 1.4 : age < c.life ? 0.3 : 0.05, pBuy: age < 20 ? 0.7 : 0.38, lo: 0.03, hi: 0.4 };
      case 'rug': return { rate: age < c.rugAt ? 2.6 : 0.9, pBuy: age < c.rugAt ? 0.8 : 0.15, lo: 0.1, hi: 1.1 };
      case 'fakeout': return { rate: age < c.fadeAt ? 2.4 : 1.3, pBuy: age < c.fadeAt ? 0.78 : 0.3, lo: 0.1, hi: 1.2 };
      case 'slow': return { rate: 1.0, pBuy: 0.55 - (age / c.life) * 0.2, lo: 0.05, hi: 0.6 };
      default: return { rate: age < c.life ? 1.6 + (age / 60) * 0.9 : 1.1, pBuy: age < c.life ? 0.64 : 0.28, lo: 0.1, hi: 1.4 };
    }
  }

  step() {
    const now = Date.now();
    for (const c of this.coins.values()) {
      if (c.dead) continue;
      const age = (now - c.born) / 1000;
      if (age > c.life + 150) { c.dead = true; continue; }
      if (c.bundle && age < 3) for (let i = 0; i < 3; i++) this.trade(c, 'buy', rnd(1, 2.5));
      if (c.kind === 'rug' && !c.rugged && age >= c.rugAt) {
        c.rugged = true;
        const tok = c.bal.get(c.creator) || 0;
        if (tok > 0) this.trade(c, 'sell', 0, c.creator, tok);
      }
      const b = this.behavior(c, age);
      const n = poisson(b.rate * 0.5);
      for (let i = 0; i < n; i++) this.trade(c, Math.random() < b.pBuy ? 'buy' : 'sell', rnd(b.lo, b.hi));
    }
  }

  trade(c, side, sol, forcedWallet, forcedTok) {
    let who, tok;
    if (side === 'buy') {
      who = c.holders.length && Math.random() < 0.25 ? pick(c.holders) : rid(44);
      tok = buyQuote(c.vSol, c.vTok, sol, 0.01);
      c.vSol += sol * 0.99; c.vTok -= tok;
      if (!c.bal.has(who)) c.holders.push(who);
      c.bal.set(who, (c.bal.get(who) || 0) + tok);
    } else {
      who = forcedWallet;
      if (!who) {
        const sellers = c.holders.filter((h) => (c.bal.get(h) || 0) > 0);
        if (!sellers.length) return;
        who = pick(sellers);
      }
      const have = c.bal.get(who) || 0;
      tok = forcedTok ?? have * rnd(0.3, 1);
      if (tok <= 0) return;
      sol = sellQuote(c.vSol, c.vTok, tok, 0);
      c.vSol = Math.max(INIT_VSOL * 0.5, c.vSol - sol); c.vTok += tok;
      c.bal.set(who, have - tok);
    }
    if (!c.migrated && c.vSol >= COMPLETE_VSOL) { c.migrated = true; this.emit('migrate', { mint: c.mint, txType: 'migrate' }); }
    if (!this.subs.has(c.mint)) return;
    this.emit('trade', {
      signature: rid(64), mint: c.mint, traderPublicKey: who, txType: side, tokenAmount: tok, solAmount: sol,
      newTokenBalance: c.bal.get(who) || 0, vSolInBondingCurve: c.vSol, vTokensInBondingCurve: c.vTok,
      marketCapSol: (c.vSol / c.vTok) * TOTAL_SUPPLY, pool: 'pump',
    });
  }
}
