import { EventEmitter } from 'node:events';
import { Learner } from '../learner.js';
import { signalHealth, bootstrapEdge, tradeMetrics, walkForward, optimizeExits, nextMood } from '../analytics.js';
import { COINS } from './data.js';
import { recall, memoryLine, recordTrade, reflect, riskTeam, MEMORY_READY } from './memory.js';
import { CRYPTO_FEATURES, cryptoFeatures, cryptoVector, cryptoScout, cryptoHunter, cryptoProfessor, shortScout, shortHunter, shortProfessor, guardianSize, guardianTurned } from './agents.js';

const AGENTS = ['scout', 'hunter', 'professor'];
const today = () => new Date().toISOString().slice(0, 10);
const VSEC = 300; // every candle counts as 5 minutes of holding time (also in the fast simulator)

export const cryptoLedgerDefaults = (cfg) => ({
  mode: cfg.mode, market: 'crypto', startBalance: cfg.crypto.startBalance, balance: cfg.crypto.startBalance,
  positions: [], trades: [], equity: [], daily: { date: today(), pnl: 0 }, paused: false,
  counters: { seen: 0, evaluated: 0, deals: 0 }, createdAt: Date.now(),
});
export const cryptoBrainDefaults = (cfg) => ({
  learner: null,
  thresholds: { scout: 0.5, hunter: 0.45, professor: 0.5 },
  agents: Object.fromEntries([...AGENTS, 'team'].map((a) => [a, { calls: 0, right: 0, buys: 0, buyWins: 0 }])),
  samples: [], curve: [], labels: 0, paths: [], exitRule: null, exitTune: null, mood: 'normal', recentY: [],
  guardian: { active: true, exits: 0, saved: 0, helped: 0 },
  shortLearner: null, shortThresholds: { scout: 0.5, hunter: 0.45, professor: 0.5 }, shortTeam: { calls: 0, wins: 0 },
  memory: { checks: 0, right: 0, recent: [] }, coinRecords: {}, lessons: [], debate: { held: 0, bullWins: 0, bearWins: 0, tooClose: 0 },
});

/**
 * Crypto desk: the same Scout / Hunter / Professor council, on 5-minute candles of major coins.
 * Lessons carried over from the meme-coin run: slow enough data that a few seconds of delay don't matter,
 * fees and slippage in every result, bars that can't lock the team out, your stop loss is never auto-changed,
 * and learning from every coin it looks at (shadow trades), not only from its own trades.
 */
export class CryptoEngine extends EventEmitter {
  constructor({ cfg, data, ledger, brain, log, notifier }) {
    super();
    Object.assign(this, { cfg, data, ledger, brain, log });
    this.notifier = notifier || { send() {}, enabled: false };
    this.C = cfg.crypto;
    for (const [k, v] of Object.entries(cryptoBrainDefaults(cfg))) if (this.B[k] === undefined) this.B[k] = v;
    this.learner = new Learner(CRYPTO_FEATURES.length, this.B.learner, CRYPTO_FEATURES);
    this.shortLearner = new Learner(CRYPTO_FEATURES.length, this.B.shortLearner, CRYPTO_FEATURES); // learns when shorts pay
    this.coins = new Map(COINS.filter(([p]) => !this.C.coins || this.C.coins.includes(p)).map(([p, name]) => [p, { product: p, name, symbol: p.split('-')[0], closed: [], lastT: 0, lastShadowT: 0, live: null }]));
    this.shadows = [];
    this.ghosts = []; // what an early-closed trade would have done without the Guardian
    this.radar = [];
    this.recentScores = { scout: [], hunter: [], professor: [], Sscout: [], Shunter: [], Sprofessor: [] };
    this.startedAt = Date.now();
    this.feedStatus = 'connecting';
    this.lastDataAt = 0;
    this.fg = null;
    this.analysisCache = null;
    this.opening = 0;
  }
  get L() { return this.ledger.state; }
  get B() { return this.brain.state; }
  get candleMs() { return this.C.candleSec * 1000; }

  /** Similar past setups (memory). */
  remember(x) { return recall(this.B.samples, x, (v) => this.learner.norm(v), Math.floor(this.learner.n / 300)); }
  /** How much memory gets to say: a little while unproven, more once it has been right more often than not. */
  memoryWeight() {
    const M = this.B.memory, r = M.recent || [];
    if (this.B.samples.length < MEMORY_READY) return 0;
    if (r.length < 50) return this.C.memoryWeight / 2;
    const acc = r.reduce((a, b) => a + b, 0) / r.length;
    return acc >= 0.52 ? this.C.memoryWeight : 0;
  }
  btcNow() { return this.coins.get('BTC-USD')?.live || null; }

  rule() {
    const base = { takeProfit: this.C.takeProfit, stopLoss: this.C.stopLoss, trailing: this.C.trailing, trailStart: this.C.trailStart, maxHoldMin: this.C.maxHoldMin };
    return this.cfg.autoTuneExits && this.B.exitRule ? { ...base, ...this.B.exitRule, stopLoss: base.stopLoss } : base;
  }
  net(q) { const s = 1 - this.C.slippage, f = 1 - this.C.fee; return q * s * s * f * f - 1; }
  /** Result of a trade when the price moved from entry to entry*q. A short gains when q falls, and pays funding while open. */
  /** Result on the money put in: the price result times the leverage (fees are on the full amount). Can't lose more than the money put in. */
  acct(p, r) { return Math.max(-1, (p.lev || 1) * r); }
  netSide(q, side, heldSec = 0) {
    if (side !== 'short') return this.net(q);
    const s = 1 - this.C.slippage, f = 1 - this.C.fee;
    return (2 - q) * s * s * f * f - 1 - this.C.fundingPer8h * (heldSec / 28_800);
  }

  start() {
    let busy = false;
    const loop = async () => { if (busy) return; busy = true; try { await this.cycle(); } catch (e) { this.log('crypto cycle error', e.message); } finally { busy = false; } };
    loop();
    setInterval(loop, this.C.pollSec * 1000);
    const fg = async () => { this.fg = await this.data.fearGreed(); };
    fg(); setInterval(fg, this.C.simulate ? 10_000 : 30 * 60_000);
    setInterval(() => this.sampleEquity(), 60_000);
    setInterval(() => this.persist(), 30_000);
    this.sampleEquity();
  }

  async cycle() {
    const now = Date.now();
    let got = 0;
    // Bitcoin first: every other coin is judged partly against it.
    for (const coin of this.coins.values()) {
      const cs = await this.data.candles(coin.product);
      if (!cs || cs.length < 130) continue;
      got++;
      const closed = cs.filter((c) => c.t + this.candleMs <= now);
      const forming = cs[cs.length - 1];
      coin.live = forming.c;
      const fresh = closed.filter((c) => c.t > coin.lastT);
      const first = !coin.lastT;
      coin.closed = closed.slice(-300);
      if (fresh.length) coin.lastT = fresh[fresh.length - 1].t;
      if (!first) for (const c of fresh) this.onCandle(coin, c);
      this.markPositions(coin);
      if (fresh.length) await this.evaluate(coin);
      if (!this.C.simulate) await new Promise((r) => setTimeout(r, 250)); // be gentle with the free API
    }
    if (got) { this.lastDataAt = now; this.feedStatus = this.C.simulate ? 'simulated' : 'live'; }
    else if (now - this.lastDataAt > 120_000) this.feedStatus = 'connecting';
    if (this.L.daily.date !== today()) {
      const y = this.L.daily;
      if (y.date) this.notifier.send(`📊 Crypto day ${y.date}: ${y.pnl >= 0 ? '+' : ''}$${y.pnl.toFixed(2)}. Balance $${this.equityNow().toFixed(2)}, ${this.L.trades.length} trades so far.`, { important: true });
      this.L.daily = { date: today(), pnl: 0 };
    }
  }

  // ---------- one closed candle: move open trades and learning trades ----------
  /** Walk low → high → close of a candle against a sell rule. Returns {fill, reason} or null. */
  step(st, c, heldSec, rule, side = 'long') {
    // Worst point first (low for a buy, high for a short), so results are never flattered.
    const order = side === 'short' ? [['worst', c.h], ['best', c.l], ['close', c.c]] : [['worst', c.l], ['best', c.h], ['close', c.c]];
    for (const [kind, px] of order) {
      const r = this.netSide(px / st.entry, side, heldSec);
      if (kind !== 'worst') st.peak = Math.max(st.peak, r);
      if (r <= -rule.stopLoss) return { fill: Math.max(r, -rule.stopLoss - 0.003), reason: 'stop loss' };
      if (r >= rule.takeProfit) return { fill: rule.takeProfit, reason: 'take profit' };
      if (kind === 'close') {
        st.last = r;
        if (st.peak >= rule.trailStart && st.peak - r >= rule.trailing) return { fill: r, reason: 'trailing stop' };
        if (heldSec >= rule.maxHoldMin * 60) return { fill: r, reason: 'time limit' };
      }
    }
    return null;
  }

  onCandle(coin, c) {
    const rule = this.rule();
    for (const p of [...this.L.positions]) {
      if (p.mint !== coin.product || c.t <= p.entryT) continue;
      const held = ((c.t - p.entryT) / this.candleMs) * VSEC;
      const out = this.step(p, c, held, rule, p.side || 'long');
      p.lastRet = p.last ?? p.lastRet; p.peakRet = p.peak;
      if (out) { this.close(p, out.fill, out.reason, held); continue; }
      // Guardian: after 3 candles, close early if the move clearly turned against the trade.
      if (this.C.guardian && this.B.guardian.active && held >= 3 * VSEC && coin.closed.length >= 130) {
        const btc = this.coins.get('BTC-USD')?.closed;
        const why = guardianTurned(cryptoFeatures(coin.closed, btc && btc.length >= 130 ? btc : null, this.fg), p.side || 'long', p.last ?? 0);
        if (why) {
          this.ghosts.push({ product: p.mint, side: p.side || 'long', entry: p.entry, entryT: p.entryT, peak: p.peak, cost: p.cost, fill: p.last, symbol: p.symbol, lev: p.lev || 1 });
          this.close(p, p.last, `Guardian: ${why}`, held);
        }
      }
    }
    for (const g of [...this.ghosts]) {
      if (g.product !== coin.product) continue;
      const held = ((c.t - g.entryT) / this.candleMs) * VSEC;
      const out = this.step(g, c, held, rule, g.side);
      if (out) this.resolveGhost(g, out.fill);
    }
    for (const s of [...this.shadows]) {
      if (s.product !== coin.product || c.t <= s.entryT) continue;
      const held = ((c.t - s.entryT) / this.candleMs) * VSEC;
      for (const px of [c.l, c.h, c.c]) if (s.path.length < 450) s.path.push([held, +this.net(px / s.entry).toFixed(5)]);
      if (!s.done) { const out = this.step(s, c, held, rule); if (out) { s.done = true; s.result = out.fill; } }
      if (s.sh && !s.sh.done) { const out = this.step(s.sh, c, held, rule, 'short'); if (out) { s.sh.done = true; s.sh.result = out.fill; } }
      s.lastClose = c.c; s.held = held;
      if (held >= 720 * 60) this.resolveShadow(s);
    }
  }

  /** Compare the Guardian's early exit with what the normal rules would have done. */
  resolveGhost(g, wouldHave) {
    this.ghosts = this.ghosts.filter((x) => x !== g);
    const G = this.B.guardian, diff = (g.fill - wouldHave) * g.cost * (g.lev || 1);
    G.exits++; G.saved += diff; if (diff > 0) G.helped++;
    if (G.exits >= 20 && G.saved < 0 && G.active) {
      G.active = false;
      this.log('Guardian: early exits cost money over 20 tries, turning them off');
      this.notifier.send(`🛡️ Guardian stopped closing trades early: over ${G.exits} tries it cost $${(-G.saved).toFixed(2)}. He keeps sizing trades.`, { important: true });
    }
  }

  markPositions(coin) {
    for (const p of this.L.positions) if (p.mint === coin.product && coin.live) {
      p.heldSec = Math.round(((Date.now() - p.openedAt) / this.candleMs) * VSEC);
      const r = this.netSide(coin.live / p.entry, p.side || 'long', p.heldSec);
      p.lastRet = r; p.acctRet = this.acct(p, r); p.value = p.cost * (1 + p.acctRet);
    }
  }

  // ---------- the council ----------
  bar(agent, score, short = false) {
    const arr = this.recentScores[(short ? 'S' : '') + agent];
    arr.push(score); if (arr.length > 400) arr.shift();
    let b = Math.min((short ? this.B.shortThresholds : this.B.thresholds)[agent], this.C.maxBars[agent]);
    if (arr.length >= 80) { const s = [...arr].sort((x, y) => x - y); b = Math.min(b, s[Math.floor(s.length * (1 - this.cfg.topPercent))]); }
    return b;
  }

  async evaluate(coin) {
    if (coin.closed.length < 130) return;
    const btc = this.coins.get('BTC-USD')?.closed;
    const f = cryptoFeatures(coin.closed, btc && btc.length >= 130 ? btc : null, this.fg);
    this.L.counters.evaluated++;
    const x = cryptoVector(f);
    const s = cryptoScout(f);
    s.vote = s.critical ? 'avoid' : s.score >= this.bar('scout', s.score) ? 'buy' : 'wait';
    const h = cryptoHunter(f, coin.product === 'BTC-USD');
    h.vote = h.critical ? 'avoid' : h.score >= this.bar('hunter', h.score) ? 'buy' : 'wait';
    const pr = cryptoProfessor(f, s, h, this.learner, x, this.C.maxAtr);
    const mem = this.remember(x), mw = this.memoryWeight();
    if (mem && mw > 0 && !pr.critical) { const brain = pr.score; pr.score = (1 - mw) * brain + mw * mem.longWin; pr.thought = `${Math.round(pr.score * 100)}% chance of profit (brain ${Math.round(brain * 100)}%, ${memoryLine(mem, 'long').toLowerCase()})`; }
    const pb = this.bar('professor', pr.score);
    pr.vote = pr.critical ? 'avoid' : pr.score >= pb ? 'buy' : 'wait';
    if (!pr.critical) pr.thought += ` · needs ${Math.round(pb * 100)}%`;
    const team = s.vote === 'buy' && h.vote === 'buy' && pr.vote === 'buy';
    const nb = (this.L.counters.notBuy ||= { scout: 0, hunter: 0, professor: 0 });
    if (s.vote !== 'buy') nb.scout++; if (h.vote !== 'buy') nb.hunter++; if (pr.vote !== 'buy') nb.professor++;
    let decision = 'pass', blocked = '';
    // ---- the short council: same three agents, looking for a fall ----
    let side = 'long', S = null, shortTeam = false;
    if (this.C.shorts) {
      const ss = shortScout(f);
      ss.vote = ss.critical ? 'avoid' : ss.score >= this.bar('scout', ss.score, true) ? 'short' : 'wait';
      const sh = shortHunter(f, coin.product === 'BTC-USD');
      sh.vote = sh.critical ? 'avoid' : sh.score >= this.bar('hunter', sh.score, true) ? 'short' : 'wait';
      const sp = shortProfessor(f, ss, sh, this.shortLearner, x, this.C.maxAtr);
      if (mem && mw > 0 && !sp.critical && mem.shortWin != null) { const brain = sp.score; sp.score = (1 - mw) * brain + mw * mem.shortWin; sp.thought = `${Math.round(sp.score * 100)}% chance a short profits (brain ${Math.round(brain * 100)}%, ${memoryLine(mem, 'short').toLowerCase()})`; }
      const spb = this.bar('professor', sp.score, true);
      sp.vote = sp.critical ? 'avoid' : sp.score >= spb ? 'short' : 'wait';
      if (!sp.critical) sp.thought += ` · needs ${Math.round(spb * 100)}%`;
      shortTeam = ss.vote === 'short' && sh.vote === 'short' && sp.vote === 'short';
      S = { s: ss, h: sh, pr: sp, bar: spb };
    }
    // ---- bull vs bear debate: a side only trades if its case clearly beats the other side's ----
    let goLong = team, goShort = shortTeam;
    if (S && (team || shortTeam)) {
      const bull = pr.score, bear = S.pr.score, gap = bull - bear, D = this.B.debate;
      const line = `Debate: bull ${Math.round(bull * 100)}% vs bear ${Math.round(bear * 100)}%`;
      D.held++;
      goLong = team && gap >= this.C.debateMargin;
      goShort = shortTeam && -gap >= this.C.debateMargin;
      if (goLong) D.bullWins++; else if (goShort) D.bearWins++; else D.tooClose++;
      if (team) pr.thought += ` · ${line}${goLong ? ', bull wins' : ', too close'}`;
      if (shortTeam) S.pr.thought += ` · ${line}${goShort ? ', bear wins' : ', too close'}`;
      if (!goLong && !goShort) { decision = 'blocked'; blocked = `bull and bear cases too close (${Math.round(bull * 100)}% vs ${Math.round(bear * 100)}%)`; }
    }
    // A "super deal": far above the bars on every count. It may use an extra slot when the normal ones are full.
    const tryOpen = (sd, V, sideName) => {
      const superDeal = V.pr.score >= Math.max(V.bar + this.C.superMargin, this.C.superMinProb) && V.s.score >= this.C.superMinScout;
      let why = this.canOpen(coin, superDeal, sideName);
      let risk = null;
      if (!why && this.C.riskTeam) {
        risk = riskTeam({ side: sideName, positions: this.L.positions, dailyPnl: this.L.daily.pnl, dailyLimit: this.C.dailyLossLimit, lastTrades: this.L.trades, mood: this.B.mood, atr: f.atr, maxAtr: this.C.maxAtr, maxSameSide: this.C.maxSameSide });
        if (risk.mult === 0) why = risk.text;
      }
      if (why) return { decision: 'blocked', blocked: why };
      const extra = this.L.positions.length + this.opening >= this.C.maxOpen;
      this.open(coin, f, { ...V, mem, risk }, extra, sideName);
      if (extra) V.pr.thought = `Super deal: ${V.pr.thought}`;
      return { decision: sideName === 'short' ? 'shorted' : 'bought', blocked: '' };
    };
    if (goLong) ({ decision, blocked } = tryOpen(true, { s, h, pr, bar: pb }, 'long'));
    else if (goShort) ({ decision, blocked } = tryOpen(true, S, 'short'));
    // Show whichever side looks more interesting on the dashboard.
    if (S && (decision === 'shorted' || goShort || (shortTeam && !team) || (!team && S.s.score > s.score && decision === 'pass'))) side = 'short';
    const lastT = coin.closed[coin.closed.length - 1].t;
    if (team || shortTeam || lastT - coin.lastShadowT >= 3 * this.candleMs) {
      coin.lastShadowT = lastT;
      if (this.shadows.length < 2500) this.shadows.push({
        product: coin.product, entry: f.price, entryT: lastT, x, peak: 0, path: [[0, 0]], team, scores: { scout: s.score, hunter: h.score, professor: pr.score }, votes: { scout: s.vote, hunter: h.vote, professor: pr.vote },
        sh: S ? { entry: f.price, peak: 0, team: shortTeam } : null,
      });
    }
    const V = side === 'short' ? S : { s, h, pr };
    const open = this.L.positions.map((p) => { const r = p.acctRet ?? p.lastRet; return `${p.symbol}${p.side === 'short' ? '↓' : ''} ${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`; }).join(', ');
    const guard = decision === 'bought' || decision === 'shorted' ? this.lastGuard : open ? `Watching ${open}` : 'No open trades to protect';
    const item = {
      at: Date.now(), mint: coin.product, symbol: coin.symbol, name: coin.name, age: 0, buyers: 0, mcapUsd: 0,
      c1: fmtPrice(f.price), c2: `${f.r288 >= 0 ? '+' : ''}${(f.r288 * 100).toFixed(1)}%`,
      meta: `${fmtPrice(f.price)} · 24h ${f.r288 >= 0 ? '+' : ''}${(f.r288 * 100).toFixed(1)}% · RSI ${f.rsi.toFixed(0)}`,
      side, votes: { scout: V.s.vote, hunter: V.h.vote, professor: V.pr.vote },
      scores: { scout: +V.s.score.toFixed(2), hunter: +V.h.score.toFixed(2), professor: +V.pr.score.toFixed(2) },
      thoughts: side === 'short' ? { scout: `Short? ${V.s.thought}`, hunter: `Short? ${V.h.thought}`, professor: `Short? ${V.pr.thought}`, guardian: guard } : { scout: s.thought, hunter: h.thought, professor: pr.thought, guardian: guard }, decision, blocked,
      guardBadge: decision === 'bought' || decision === 'shorted' ? `${this.L.positions[this.L.positions.length - 1]?.sizeMult ?? 1}x` : this.L.positions.length ? 'WATCH' : 'IDLE',
    };
    this.radar.unshift(item); if (this.radar.length > 40) this.radar.length = 40;
    this.emit('radar', item);
  }

  canOpen(coin, superDeal = false, side = 'long') {
    if (this.L.paused) return 'paused';
    if (this.L.positions.some((p) => p.mint === coin.product)) return 'already holding it';
    const rec = this.B.coinRecords[`${coin.symbol} ${side}`];
    if (rec && rec.restUntil > Date.now()) return `resting ${coin.symbol} ${side === 'short' ? 'shorts' : 'buys'} after ${this.C.coinRestAfter} losses in a row (${Math.ceil((rec.restUntil - Date.now()) / 3_600_000)}h left)`;
    const limit = this.C.maxOpen + (superDeal ? this.C.superSlots : 0);
    if (this.L.positions.length + this.opening >= limit) return superDeal ? 'even the super-deal slot is full' : 'max open positions';
    if (this.L.daily.pnl <= -this.C.dailyLossLimit) return 'daily loss limit reached';
    if ((this.L.cooldownUntil || 0) > Date.now()) return 'cooling down after losses';
    if (this.L.balance < this.C.tradeSize * this.C.guardMinMult) return 'not enough practice balance';
    return '';
  }

  open(coin, f, v, superDeal = false, side = 'long') {
    const now = Date.now();
    const bar = v.bar ?? this.bar('professor', v.pr.score, side === 'short');
    const g = this.C.guardian ? guardianSize(this.C.tradeSize, v.pr.score, bar, f.atr, this.L.balance, this.C.guardMinMult, this.C.guardMaxMult) : { size: this.C.tradeSize, mult: 1, why: '' };
    const rm = v.risk ? v.risk.mult : 1;
    const cost = +(g.size * rm).toFixed(2);
    this.lastGuard = `Size $${cost.toFixed(0)} (${(g.mult * rm).toFixed(1)}x): ${g.why}${v.risk ? ` · ${v.risk.text}` : ''}`;
    const memWin = v.mem ? (side === 'short' ? v.mem.shortWin : v.mem.longWin) : null;
    const p = {
      id: `${now}-${coin.symbol}`, mint: coin.product, symbol: coin.symbol, name: coin.name, openedAt: now,
      side, lev: this.C.leverage, btcEntry: this.btcNow(), memWin, entryT: coin.closed[coin.closed.length - 1].t, entry: f.price, cost, value: cost, acctRet: 0, peak: 0, peakRet: 0, lastRet: 0, heldSec: 0,
      thoughts: { scout: v.s.thought, hunter: v.h.thought, professor: v.pr.thought, guardian: this.lastGuard }, sizeMult: +(g.mult * rm).toFixed(2),
    };
    this.L.balance -= cost;
    this.L.positions.push(p);
    this.L.counters.deals++;
    if (superDeal) p.superDeal = true;
    const levTxt = this.C.leverage > 1 ? ` x${this.C.leverage} (controls $${(cost * this.C.leverage).toFixed(0)})` : '';
    this.log(`DEAL crypto ${side === 'short' ? 'SHORT' : 'buy'} ${coin.symbol} $${cost}${levTxt} at ${fmtPrice(f.price)}${superDeal ? ' (super deal, extra slot)' : ''}`);
    this.emit('deal', this.publicPos(p));
    this.notifier.send(`${superDeal ? '⭐ SUPER DEAL (extra slot) ' : ''}${side === 'short' ? '🔽 Practice SHORT' : '🟢 Practice buy'} ${coin.symbol} $${cost.toFixed(2)}${levTxt} at ${fmtPrice(f.price)}\nProfessor: ${v.pr.thought}\nGuardian: ${this.lastGuard}`);
    this.ledger.save();
  }

  close(p, fillRet, reason, heldSec) {
    if (!this.L.positions.includes(p)) return;
    const now = Date.now();
    const ret = this.acct(p, fillRet);
    const proceeds = p.cost * (1 + ret);
    const trade = { id: p.id, mint: p.mint, symbol: p.symbol, name: p.name, openedAt: p.openedAt, closedAt: now, side: p.side || 'long', cost: p.cost, proceeds, pnl: proceeds - p.cost, ret, priceRet: fillRet, lev: p.lev || 1, reason, holdSec: Math.round(heldSec ?? p.heldSec ?? 0), estimated: false };
    this.L.balance += proceeds;
    this.L.positions = this.L.positions.filter((x) => x !== p);
    this.L.trades.unshift(trade); if (this.L.trades.length > 1000) this.L.trades.length = 1000;
    this.L.daily.pnl += trade.pnl;
    // Reflection: what happened, was memory right, how this coin+side is doing.
    const side = p.side || 'long', btc = this.btcNow();
    const { r: rec, rested } = recordTrade(this.B.coinRecords, `${p.symbol} ${side}`, trade.pnl, this.C.coinRestAfter, this.C.coinRestHours * 3_600_000);
    const lesson = reflect({ symbol: p.symbol, side, ret, reason, btcMove: p.btcEntry && btc ? btc / p.btcEntry - 1 : null, memWin: p.memWin ?? null, rec, rested, restHours: this.C.coinRestHours });
    trade.lesson = lesson;
    this.B.lessons.unshift({ at: now, symbol: p.symbol, side, pnl: +trade.pnl.toFixed(2), text: lesson }); if (this.B.lessons.length > 60) this.B.lessons.length = 60;
    const priceTxt = (p.lev || 1) > 1 ? ` (price ${(fillRet * 100).toFixed(2)}% x${p.lev})` : '';
    this.log(`EXIT ${p.side === 'short' ? 'short ' : ''}${p.symbol} ${(ret * 100).toFixed(1)}%${priceTxt} (${reason})`);
    this.emit('exit', trade);
    this.notifier.send(`${trade.pnl >= 0 ? '✅' : '🔻'} ${p.side === 'short' ? 'Closed short' : 'Sold'} ${p.symbol}: ${(ret * 100).toFixed(1)}%${priceTxt} (${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}), ${reason}\n📝 ${lesson}`);
    this.sampleEquity();
    this.checkBreaker();
    this.ledger.save();
  }

  checkBreaker() {
    let streak = 0; for (const t of this.L.trades) { if (t.pnl < 0) streak++; else break; }
    const peak = this.L.ddPeak ?? Math.max(this.L.startBalance, ...this.L.equity.map((e) => e.v));
    const dd = peak > 0 ? 1 - this.equityNow() / peak : 0;
    let why = '';
    if (streak >= this.cfg.lossStreakPause) why = `${streak} losing trades in a row`;
    else if (dd >= this.cfg.maxDrawdownPct) why = `down ${(dd * 100).toFixed(0)}% from the best balance`;
    if (!why || (this.L.cooldownUntil || 0) > Date.now()) return;
    this.L.cooldownUntil = Date.now() + this.cfg.cooldownMin * 60_000; this.L.cooldownWhy = why;
    if (dd >= this.cfg.maxDrawdownPct) this.L.ddPeak = this.equityNow();
    this.log(`circuit breaker: ${why}`);
    this.notifier.send(`⏸ Circuit breaker: ${why}. No new buys for ${this.cfg.cooldownMin} minutes.`, { important: true });
  }

  // ---------- learning ----------
  resolveShadow(s) {
    const i = this.shadows.indexOf(s); if (i < 0) return; this.shadows.splice(i, 1);
    const ret = s.done ? s.result : s.path[s.path.length - 1][1];
    const y = ret > 0 ? 1 : 0;
    // Check memory before it sees this coin's result: would similar past setups have called it right?
    const m = this.remember(s.x);
    if (m) { const M = this.B.memory, ok = (m.longWin >= 0.5) === (y === 1) ? 1 : 0; M.checks++; M.right += ok; (M.recent ||= []).push(ok); if (M.recent.length > 200) M.recent.shift(); }
    this.learner.learn(s.x, y);
    let sret = null;
    if (s.sh) {
      sret = s.sh.done ? s.sh.result : this.netSide((s.lastClose ?? s.entry) / s.entry, 'short', s.held || 0);
      this.shortLearner.learn(s.x, sret > 0 ? 1 : 0);
      if (s.sh.team) { this.B.shortTeam.calls++; if (sret > 0) this.B.shortTeam.wins++; }
    }
    const A = this.B.agents;
    for (const a of AGENTS) { const v = s.votes[a], st = A[a]; if (v === 'buy') { st.calls++; st.buys++; if (y) { st.right++; st.buyWins++; } } else if (v === 'avoid') { st.calls++; if (!y) st.right++; } }
    if (s.team) { A.team.buys++; if (y) A.team.buyWins++; }
    this.B.samples.push({ p: s.scores.professor, scout: s.scores.scout, hunter: s.scores.hunter, ret: +ret.toFixed(5), sret: sret == null ? null : +sret.toFixed(5), x: s.x.map((v) => +v.toFixed(3)) });
    if (this.B.samples.length > 3000) this.B.samples.splice(0, this.B.samples.length - 3000);
    this.B.paths.push(s.path); if (this.B.paths.length > 450) this.B.paths.splice(0, this.B.paths.length - 450);
    this.B.recentY.push(y); if (this.B.recentY.length > 80) this.B.recentY.shift();
    const prev = this.B.mood;
    this.B.mood = nextMood(prev, this.B.recentY.length >= 30 ? this.B.recentY.reduce((a, b) => a + b, 0) / this.B.recentY.length : null, { hot: 0.6, hotExit: 0.52, cold: 0.35, coldExit: 0.42 });
    if (prev !== this.B.mood) this.notifier.send(`Market mood: ${prev} → ${this.B.mood}`, { important: true });
    this.B.labels++;
    if (this.B.labels % 10 === 0) { this.B.curve.push({ t: Date.now(), acc: this.learner.accuracy(), n: this.learner.n }); if (this.B.curve.length > 1500) this.B.curve.shift(); }
    if (this.B.labels % 20 === 0) this.retune();
    if (this.B.labels % 50 === 0) this.tuneExits();
  }

  retune() {
    const S = this.B.samples; if (S.length < 80) return;
    const best = (key, grid, floor) => {
      let pick = null;
      for (const thr of grid) { const sel = S.filter((s) => s[key] >= thr); if (sel.length < 15) continue; const ev = sel.reduce((a, s) => a + s.ret, 0) / sel.length; if (!pick || ev > pick.ev) pick = { thr, ev }; }
      return pick ? Math.max(floor, pick.thr) : null;
    };
    const g = (a, b) => Array.from({ length: Math.round((b - a) / 0.05) + 1 }, (_, i) => +(a + i * 0.05).toFixed(2));
    const th = this.B.thresholds, mb = this.C.maxBars;
    th.scout = Math.min(mb.scout, best('scout', g(0.25, 0.85), 0.25) ?? th.scout);
    th.hunter = Math.min(mb.hunter, best('hunter', g(0.2, 0.85), 0.2) ?? th.hunter);
    th.professor = Math.min(mb.professor, best('p', g(0.25, 0.85), 0.25) ?? th.professor);
  }

  tuneExits() {
    if (!this.cfg.autoTuneExits) return;
    const cur = this.rule(), grid = [];
    for (const takeProfit of [0.008, 0.012, 0.016, 0.02, 0.03, 0.04].filter((v) => v <= this.C.maxTakeProfit + 1e-9))
      for (const trailing of [0.004, 0.008, 0.012])
        for (const maxHoldMin of [120, 360, 720]) grid.push({ takeProfit, stopLoss: cur.stopLoss, trailing, trailStart: cur.trailStart, maxHoldMin });
    const res = optimizeExits(this.B.paths, cur, this.C.maxTakeProfit, grid);
    if (!res) return;
    this.B.exitTune = { ...res, at: Date.now() };
    if (res.accepted && JSON.stringify(res.rule) !== JSON.stringify(this.B.exitRule)) {
      this.B.exitRule = res.rule;
      const r = res.rule;
      this.log(`crypto sell rule tuned: +${(r.takeProfit * 100).toFixed(1)}% / trail ${(r.trailing * 100).toFixed(1)}% / ${r.maxHoldMin} min`);
      this.notifier.send(`🧠 New sell rule: take profit +${(r.takeProfit * 100).toFixed(1)}%, trailing ${(r.trailing * 100).toFixed(1)}%, max hold ${r.maxHoldMin / 60}h (stop loss unchanged)`, { important: true });
    }
  }

  // ---------- dashboard ----------
  analysis() {
    if (this.analysisCache && Date.now() - this.analysisCache.at < 60_000) return this.analysisCache.data;
    const data = {
      edge: bootstrapEdge(this.L.trades.map((t) => t.ret)),
      metrics: tradeMetrics(this.L.trades, this.L.equity, this.L.startBalance),
      signals: signalHealth(this.B.samples, 40, CRYPTO_FEATURES),
      walkForward: walkForward(this.learner.recent),
      mood: this.B.mood, rule: this.rule(), ruleTuned: !!(this.cfg.autoTuneExits && this.B.exitRule), exitTune: this.B.exitTune, paths: this.B.paths.length,
      breaker: (this.L.cooldownUntil || 0) > Date.now() ? { until: this.L.cooldownUntil, why: this.L.cooldownWhy } : null,
      alerts: this.notifier.enabled, alertChannel: this.notifier.channel, alertWaiting: !!(this.notifier.tgToken && !this.notifier.tgChat),
    };
    this.analysisCache = { at: Date.now(), data };
    return data;
  }
  publicPos(p) { const { peak, last, ...rest } = p; return rest; }
  equityNow() { return this.L.balance + this.L.positions.reduce((a, p) => a + (p.value ?? p.cost), 0); }
  sampleEquity() {
    const E = this.L.equity, v = +this.equityNow().toFixed(4);
    E.push({ t: Date.now(), v }); if (this.L.ddPeak != null) this.L.ddPeak = Math.max(this.L.ddPeak, v);
    if (E.length > 4000) { const half = E.splice(0, 2000); E.unshift(...half.filter((_, i) => i % 2 === 0)); }
  }
  persist() { this.B.learner = this.learner.toJSON(); this.B.shortLearner = this.shortLearner.toJSON(); this.brain.save(); this.ledger.save(); }

  async control(action) {
    if (action === 'pause') this.L.paused = true;
    else if (action === 'resume') { this.L.paused = false; this.L.cooldownUntil = 0; }
    else if (action === 'closeAll') { for (const p of [...this.L.positions]) this.close(p, p.lastRet || 0, 'closed by you', p.heldSec); }
    else return { ok: false, error: 'Unknown action' };
    this.ledger.save();
    return { ok: true, paused: this.L.paused };
  }

  snapshot(full) {
    const now = Date.now(), trades = this.L.trades, wins = trades.filter((t) => t.pnl > 0).length, eq = this.equityNow(), A = this.B.agents;
    const acc = (a) => (A[a].calls ? A[a].right / A[a].calls : null);
    const r = this.rule();
    const snap = {
      market: 'crypto', unit: 'USD', mode: this.cfg.mode, feed: this.feedStatus, paused: this.L.paused, startedAt: this.startedAt, now,
      solUsd: 1, hunterSource: 'Fear & Greed + Bitcoin trend', controlsEnabled: !!this.cfg.password, liveReady: true, wallet: null,
      labels: {
        scoutRole: 'Reads each coin\'s chart: trend, momentum, volume', hunterRole: 'Reads the market mood: Fear & Greed, Bitcoin',
        professorRole: 'Checks the risk, makes the call', feedLive: this.C.simulate ? 'Simulated prices' : 'Coinbase prices live',
        radarC1: 'Price', radarC2: '24h', kSeen: 'Chart checks', kSeenSub: `${this.coins.size} coins watched · ${this.L.counters.deals} deals`,
        empty: 'No open trades. The team buys only when all three agree.',
        topPill: this.coins.get('BTC-USD')?.live ? `BTC ${fmtPrice(this.coins.get('BTC-USD').live)}` : 'BTC —',
      },
      balance: this.L.balance, startBalance: this.L.startBalance, equity: eq,
      pnl: eq - this.L.startBalance, pnlPct: eq / this.L.startBalance - 1, todayPnl: this.L.daily.pnl,
      stats: { trades: trades.length, wins, winRate: trades.length ? wins / trades.length : null, avgRet: trades.length ? trades.reduce((a, t) => a + t.ret, 0) / trades.length : null, best: trades.reduce((a, t) => Math.max(a, t.ret), -Infinity), worst: trades.reduce((a, t) => Math.min(a, t.ret), Infinity) },
      positions: this.L.positions.map((p) => this.publicPos(p)),
      agents: {
        scout: { accuracy: acc('scout'), calls: A.scout.calls, threshold: this.B.thresholds.scout },
        hunter: { accuracy: acc('hunter'), calls: A.hunter.calls, threshold: this.B.thresholds.hunter },
        professor: { accuracy: acc('professor'), calls: A.professor.calls, threshold: this.B.thresholds.professor },
        team: { buys: A.team.buys, winRate: A.team.buys ? A.team.buyWins / A.team.buys : null },
        guardian: this.C.guardian ? { ...this.B.guardian, saved: +this.B.guardian.saved.toFixed(2), pending: this.ghosts.length } : null,
        shortTeam: { calls: this.B.shortTeam.calls, winRate: this.B.shortTeam.calls ? this.B.shortTeam.wins / this.B.shortTeam.calls : null },
      },
      shorts: !!this.C.shorts,
      memory: (() => {
        const M = this.B.memory, r = M.recent || [];
        const recs = Object.entries(this.B.coinRecords).map(([k, v]) => ({ key: k, n: v.n, wins: v.wins, pnl: +v.pnl.toFixed(2), resting: v.restUntil > now })).sort((a, b) => b.pnl - a.pnl);
        return { size: this.B.samples.length, ready: MEMORY_READY, checks: M.checks, accuracy: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null, weight: this.memoryWeight(), debate: this.B.debate, records: recs, lessons: this.B.lessons.slice(0, 8), riskTeam: !!this.C.riskTeam };
      })(),
      learning: { samples: this.learner.n, accuracy: this.learner.accuracy(), watching: this.shadows.length },
      counters: { ...this.L.counters, seen: this.L.counters.evaluated, tracked: this.coins.size },
      meta: null,
      config: { tradeSizeSol: this.C.tradeSize, ...r, leverage: this.C.leverage, maxOpen: this.C.maxOpen, dailyLossLimitSol: this.C.dailyLossLimit },
    };
    if (full) {
      snap.trades = trades.slice(0, 60); snap.radar = this.radar;
      const E = this.L.equity, st = Math.max(1, Math.ceil(E.length / 600));
      snap.equitySeries = E.filter((_, i) => i % st === 0 || i === E.length - 1);
      snap.learning.curve = this.B.curve.slice(-300);
      snap.learning.factors = this.learner.n >= 30 ? this.learner.factors().slice(0, 7) : [];
      snap.analysis = this.analysis();
    }
    return snap;
  }
}

function fmtPrice(v) {
  if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toPrecision(3);
}
