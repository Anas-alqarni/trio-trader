import { progress, TOTAL_SUPPLY } from './curve.js';

/** Keeps a live picture of every coin the team is watching, built from the trade stream. */
export class Market {
  constructor() { this.tokens = new Map(); }

  create(m, now) {
    if (!m?.mint || this.tokens.has(m.mint)) return null;
    const vSol = +m.vSolInBondingCurve || 30;
    const vTok = +m.vTokensInBondingCurve || 1.073e9;
    const price = vSol / vTok;
    const t = {
      mint: m.mint,
      name: String(m.name || '').slice(0, 40),
      symbol: String(m.symbol || '').slice(0, 14),
      uri: m.uri || '',
      creator: m.traderPublicKey || '',
      createdAt: now,
      initialBuySol: +m.solAmount || 0,
      vSol, vTok, price, firstPrice: price, peak: price,
      mcapSol: +m.marketCapSol || price * TOTAL_SUPPLY,
      trades: 0, buys: 0, sells: 0, buySol: 0, sellSol: 0,
      buyers: new Set(), sellers: new Set(), balances: new Map(), recent: [],
      creatorSold: false, creatorSoldSol: 0, sniperTok: 0,
      lastTradeAt: now, meta: null, migrated: false,
      checkpoints: new Set(), evaluating: false, shadowed: false,
    };
    if (t.creator) t.balances.set(t.creator, +m.initialBuy || 0);
    this.tokens.set(t.mint, t);
    return t;
  }

  /** Rebuild a minimal coin record for a position that survived a restart. */
  restore(p, now) {
    if (this.tokens.has(p.mint)) return this.tokens.get(p.mint);
    const s = p.last || {};
    const t = this.create({ mint: p.mint, name: p.name, symbol: p.symbol, vSolInBondingCurve: s.vSol, vTokensInBondingCurve: s.vTok }, now);
    t.createdAt = p.openedAt - 60_000;
    t.price = s.price || t.price; t.migrated = !!s.migrated; t.checkpoints = new Set([Infinity]);
    return t;
  }

  trade(m, now) {
    const t = this.tokens.get(m.mint);
    if (!t) return null;
    const side = m.txType, sol = +m.solAmount || 0, tok = +m.tokenAmount || 0, who = m.traderPublicKey || '';
    t.trades++; t.lastTradeAt = now;
    if (side === 'buy') {
      t.buys++; t.buySol += sol;
      if (who !== t.creator) { t.buyers.add(who); if (now - t.createdAt < 3000) t.sniperTok += tok; }
    } else {
      t.sells++; t.sellSol += sol; t.sellers.add(who);
      if (who === t.creator) { t.creatorSold = true; t.creatorSoldSol += sol; }
    }
    const prev = t.balances.get(who) || 0;
    const nb = m.newTokenBalance !== undefined ? +m.newTokenBalance : Math.max(0, prev + (side === 'buy' ? tok : -tok));
    if (nb > 0) t.balances.set(who, nb); else t.balances.delete(who);
    if (m.vSolInBondingCurve && m.vTokensInBondingCurve) {
      t.vSol = +m.vSolInBondingCurve; t.vTok = +m.vTokensInBondingCurve; t.price = t.vSol / t.vTok;
    } else if (m.marketCapSol) {
      t.price = +m.marketCapSol / TOTAL_SUPPLY;
    }
    if (m.marketCapSol) t.mcapSol = +m.marketCapSol; else t.mcapSol = t.price * TOTAL_SUPPLY;
    if (t.price > t.peak) t.peak = t.price;
    t.recent.push({ t: now, side, sol });
    if (t.recent.length > 400) t.recent.splice(0, t.recent.length - 400);
    return t;
  }

  features(t, now) {
    const age = Math.max(1, (now - t.createdAt) / 1000);
    let b30 = 0, s30 = 0, bp = 0, sp = 0;
    for (let i = t.recent.length - 1; i >= 0; i--) {
      const r = t.recent[i], dt = now - r.t;
      if (dt > 60_000) break;
      if (dt <= 30_000) { if (r.side === 'buy') b30 += r.sol; else s30 += r.sol; }
      else if (r.side === 'buy') bp += r.sol; else sp += r.sol;
    }
    let top = 0;
    for (const [w, b] of t.balances) if (w !== t.creator && b > top) top = b;
    return {
      age,
      buyers: t.buyers.size, sellers: t.sellers.size, buys: t.buys, sells: t.sells,
      ratio: t.buys / (t.sells + 1),
      netFlow: t.buySol - t.sellSol,
      buyVel: b30, vel: b30 - s30, accel: (b30 - s30) - (bp - sp),
      progress: progress(t.vSol),
      growth: t.price / t.firstPrice,
      drawdown: t.price / t.peak - 1,
      topHolderPct: top / TOTAL_SUPPLY,
      creatorPct: (t.balances.get(t.creator) || 0) / TOTAL_SUPPLY,
      creatorSold: t.creatorSold,
      sniperPct: t.sniperTok / TOTAL_SUPPLY,
      tradeRate: t.trades / Math.max(age / 60, 0.25),
      mcapSol: t.mcapSol,
    };
  }

  remove(mint) { this.tokens.delete(mint); }
}
