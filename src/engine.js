import { EventEmitter } from 'node:events';
import { scout } from './agents/scout.js';
import { professor, exitReason } from './agents/professor.js';
import { Learner, vectorize, FEATURE_NAMES } from './learner.js';
import { buyQuote, sellQuote } from './curve.js';
import { signalHealth, bootstrapEdge, tradeMetrics, walkForward, optimizeExits, replay, nextMood } from './analytics.js';


const AGENTS = ['scout', 'hunter', 'professor'];
const today = () => new Date().toISOString().slice(0, 10);

export const ledgerDefaults = (cfg) => ({
  mode: cfg.mode, startBalance: cfg.startBalanceSol, balance: cfg.startBalanceSol,
  positions: [], trades: [], equity: [], daily: { date: today(), pnl: 0 }, paused: false,
  counters: { seen: 0, evaluated: 0, deals: 0 }, createdAt: Date.now(),
});
export const brainDefaults = () => ({
  learner: null,
  thresholds: { scout: 0.5, hunter: 0.35, professor: 0.55 },
  agents: Object.fromEntries([...AGENTS, 'team'].map((a) => [a, { calls: 0, right: 0, buys: 0, buyWins: 0 }])),
  samples: [], curve: [], labels: 0,
  paths: [], exitRule: null, exitTune: null, mood: 'normal', recentY: [],
});

/**
 * The trading desk. For every new pump.fun coin:
 *   watch it → at each checkpoint the Scout, Hunter and Professor vote → BUY only if all three say buy.
 * It also "shadow trades" coins it did not buy, so it learns from thousands of outcomes, not just its own trades.
 */
export class Engine extends EventEmitter {
  constructor({ cfg, feed, market, hunter, broker, ledger, brain, sol, log, fetchMeta, dexPrice, metaStats, notifier }) {
    super();
    Object.assign(this, { cfg, feed, market, hunter, broker, ledger, brain, sol, log, fetchMeta, dexPrice });
    this.metaStats = metaStats || null;
    this.notifier = notifier || { send() {}, enabled: false };
    this.recentScores = { scout: [], hunter: [], professor: [] };
    // One-time: the old tuner could aim for +100%. Bring take profit down to the cap, keep the stop loss.
    if (this.B.exitRule && this.B.exitRule.takeProfit > this.cfg.maxTakeProfit) {
      this.B.exitRule = { ...this.B.exitRule, takeProfit: Math.min(0.3, this.cfg.maxTakeProfit), trailing: Math.min(this.B.exitRule.trailing, 0.12) };
    }
    for (const k of ['scout', 'hunter', 'professor']) this.B.thresholds[k] = Math.min(this.B.thresholds[k], this.cfg.maxBars[k]);
    this.analysisCache = null;
    for (const [k, v] of Object.entries(brainDefaults())) if (this.B[k] === undefined) this.B[k] = v;
    this.learner = new Learner(FEATURE_NAMES.length, brain.state.learner);
    this.shadows = new Map();
    this.radar = [];
    this.lastQuietRadar = 0;
    this.startedAt = Date.now();
    this.feedStatus = feed.status || 'connecting';
    this.wallet = null;
  }
  get L() { return this.ledger.state; }
  get B() { return this.brain.state; }

  start() {
    this.feed.on('status', (s) => { this.feedStatus = s; });
    this.feed.on('create', (m) => this.onCreate(m));
    this.feed.on('trade', (m) => this.onTrade(m));
    this.feed.on('migrate', (m) => { const t = this.market.tokens.get(m.mint); if (t) t.migrated = true; });
    for (const p of this.L.positions) { this.market.restore(p, Date.now()); this.feed.subscribe([p.mint]); p.closing = false; }
    setInterval(() => this.tick(), 1000);
    setInterval(() => this.sampleEquity(), 60_000);
    setInterval(() => this.persist(), 30_000);
    if (this.cfg.live) { const w = async () => { this.wallet = await this.broker.walletBalance(); }; w(); setInterval(w, 60_000); }
    this.sampleEquity();
  }

  /** The sell rule in force: the tuned one if self-tuning is on, otherwise the settings. */
  rule() {
    const base = { takeProfit: this.cfg.takeProfit, stopLoss: this.cfg.stopLoss, trailing: this.cfg.trailing, maxHoldMin: this.cfg.maxHoldMin };
    return this.cfg.autoTuneExits && this.B.exitRule ? { ...base, ...this.B.exitRule } : base;
  }

  // ---------- costs ----------
  quoteBuy(t, sol) {
    const fee = this.cfg.feePct, lat = 1 - this.cfg.latencyPenaltyPct;
    if (t.migrated || !t.vSol) return (sol * (1 - fee - 0.003)) / t.price * lat;
    return buyQuote(t.vSol, t.vTok, sol, fee) * lat;
  }
  quoteSell(t, tok) {
    const fee = this.cfg.feePct, lat = 1 - this.cfg.latencyPenaltyPct;
    if (t.migrated || !t.vSol) return tok * t.price * (1 - fee - 0.003) * lat;
    return sellQuote(t.vSol, t.vTok, tok, fee) * lat;
  }

  // ---------- feed ----------
  onCreate(m) {
    const now = Date.now();
    const t = this.market.create(m, now);
    if (!t) return;
    this.L.counters.seen++;
    this.feed.subscribe([t.mint]);
    this.fetchMeta(t).then((meta) => { if (meta) { t.meta = meta; this.hunter.register(t); } }).catch(() => {});
    this.evict();
  }

  onTrade(m) {
    const now = Date.now();
    const t = this.market.trade(m, now);
    if (!t) return;
    const p = this.L.positions.find((x) => x.mint === t.mint);
    if (p) this.checkPosition(p, t, now);
    const s = this.shadows.get(t.mint);
    if (s) this.updateShadow(s, t, now);
  }

  holding(mint) { return this.L.positions.some((p) => p.mint === mint); }

  evict() {
    if (this.market.tokens.size <= this.cfg.maxTracked) return;
    for (const t of this.market.tokens.values()) {
      if (this.market.tokens.size <= this.cfg.maxTracked * 0.9) break;
      if (!this.holding(t.mint) && !this.shadows.has(t.mint) && !t.evaluating) this.drop(t);
    }
  }
  drop(t) { this.feed.unsubscribe([t.mint]); this.market.remove(t.mint); }

  // ---------- main loop ----------
  tick() {
    const now = Date.now();
    for (const t of this.market.tokens.values()) {
      const held = this.holding(t.mint);
      const age = (now - t.createdAt) / 1000;
      if (!t.evaluating && !held) {
        const due = this.cfg.checkpoints.some((c) => age >= c && !t.checkpoints.has(c));
        if (due) {
          for (const c of this.cfg.checkpoints) if (age >= c) t.checkpoints.add(c);
          this.evaluate(t).catch((e) => { t.evaluating = false; this.log('evaluate error', e.message); });
        }
      }
      if (age > this.cfg.watchMinutes * 60 && !held && !this.shadows.has(t.mint) && !t.evaluating) this.drop(t);
    }
    for (const p of [...this.L.positions]) {
      const t = this.market.tokens.get(p.mint);
      if (t) this.checkPosition(p, t, now);
    }
    for (const s of [...this.shadows.values()]) {
      const t = this.market.tokens.get(s.mint);
      if (t) this.updateShadow(s, t, now); else this.resolveShadow(s, s.lastRet, 'coin dropped');
    }
    if (this.L.daily.date !== today()) {
      const y = this.L.daily;
      if (y.date) this.notifier.send(`📊 Day ${y.date}: ${y.pnl >= 0 ? '+' : ''}${y.pnl.toFixed(4)} SOL. Balance ${this.equityNow().toFixed(3)} SOL, ${this.L.trades.length} trades so far, brain accuracy ${this.learner.accuracy() == null ? '—' : Math.round(this.learner.accuracy() * 100) + '%'}.`, { important: true });
      this.L.daily = { date: today(), pnl: 0 };
    }
  }

  // ---------- the council ----------
  async evaluate(t) {
    if (t.trades < 4) return; // too quiet to judge
    t.evaluating = true;
    this.L.counters.evaluated++;
    try {
      const th = this.B.thresholds;
      let f = this.market.features(t, Date.now());
      const s = scout(f);
      s.vote = s.critical ? 'avoid' : s.score >= this.bar('scout', s.score) ? 'buy' : 'wait';

      let h = this.hunter.quick(t);
      if (s.vote === 'buy') h = await this.hunter.deep(t);
      // No links loaded yet = no information, so the Hunter does not block; he only blocks on what he can see.
      h.vote = h.critical ? 'avoid' : !t.meta || h.score >= this.bar('hunter', h.score) ? 'buy' : 'wait';
      if (!t.meta && !h.critical) h.thought = 'Links not loaded, no objection';

      f = this.market.features(t, Date.now()); // fresh numbers after any X lookup
      const x = vectorize(f, h.score);
      const pr = professor(f, s, h, this.learner, x);
      const profBar = this.bar('professor', pr.score, this.cfg.coldMarketStricter && this.B.mood === 'cold' ? 0.1 : 0);
      pr.vote = pr.critical ? 'avoid' : pr.score >= profBar ? 'buy' : 'wait';
      if (!pr.critical) pr.thought += ` · needs ${Math.round(profBar * 100)}%`;

      const team = s.vote === 'buy' && h.vote === 'buy' && pr.vote === 'buy';
      const nb = (this.L.counters.notBuy ||= { scout: 0, hunter: 0, professor: 0 });
      if (s.vote !== 'buy') nb.scout++;
      if (h.vote !== 'buy') nb.hunter++;
      if (pr.vote !== 'buy') nb.professor++;
      if (s.vote === 'buy' && pr.vote === 'buy' && h.vote !== 'buy') this.L.counters.onlyHunter = (this.L.counters.onlyHunter || 0) + 1;
      let decision = team ? 'buy' : 'pass', blocked = '';
      if (team) {
        blocked = this.canOpen(t);
        if (!blocked) { const ok = await this.open(t, { s, h, pr }); decision = ok ? 'bought' : 'failed'; }
        else decision = 'blocked';
      }
      if (!t.shadowed && this.shadows.size < this.cfg.maxShadows && (f.age >= 40 || team)) this.addShadow(t, x, { s, h, pr }, team);
      this.pushRadar(t, f, { s, h, pr }, decision, blocked);
    } finally {
      t.evaluating = false;
    }
  }

  canOpen(t) {
    if (this.L.paused) return 'paused';
    if (this.holding(t.mint) || t.bought) return 'already traded this coin';
    if (this.L.positions.length + (this.opening || 0) >= this.cfg.maxOpen) return 'max open positions';
    if (this.L.daily.pnl <= -this.cfg.dailyLossLimitSol) return 'daily loss limit reached';
    if ((this.L.cooldownUntil || 0) > Date.now()) return `cooling down after losses until ${new Date(this.L.cooldownUntil).toISOString().slice(11, 16)} UTC`;
    if (!this.broker.ready) return 'live trading needs PUMPPORTAL_API_KEY';
    if (this.broker.errors >= 3) return 'stopped after 3 trade errors';
    if (!this.cfg.live && this.L.balance < this.cfg.tradeSizeSol + this.cfg.priorityFeeSol) return 'not enough practice balance';
    return '';
  }

  async open(t, v) {
    const size = this.cfg.tradeSizeSol, now = Date.now();
    let fill;
    this.opening = (this.opening || 0) + 1; // reserve the slot while the order is in flight
    try { fill = await this.broker.buy(t, size, this); } catch (e) { this.log('buy failed', t.symbol, e.message); return false; } finally { this.opening--; }
    const cost = size + this.cfg.priorityFeeSol;
    const p = {
      id: `${now}-${t.mint.slice(0, 6)}`, mint: t.mint, symbol: t.symbol, name: t.name, openedAt: now,
      cost, tokens: fill.tokens, entryPrice: t.price, entryMcapUsd: t.mcapSol * this.sol.usd,
      peakRet: 0, lastRet: 0, value: cost, creatorSoldAtEntry: t.creatorSold, signature: fill.signature || null, estimated: fill.estimated,
      votes: { scout: v.s.score, hunter: v.h.score, professor: v.pr.score },
      thoughts: { scout: v.s.thought, hunter: v.h.thought, professor: v.pr.thought },
      last: { vSol: t.vSol, vTok: t.vTok, price: t.price, migrated: t.migrated },
    };
    t.bought = true;
    this.L.balance -= cost;
    this.L.positions.push(p);
    this.L.counters.deals++;
    this.log(`DEAL ${this.cfg.mode.toUpperCase()} buy $${t.symbol} ${size} SOL`);
    this.emit('deal', this.publicPos(p, now));
    this.notifier.send(`🟢 ${this.cfg.mode === 'live' ? 'REAL' : 'Practice'} buy $${t.symbol} for ${size} SOL\nProfessor: ${v.pr.thought}\nhttps://pump.fun/coin/${t.mint}`);
    this.ledger.save();
    return true;
  }

  checkPosition(p, t, now) {
    if (p.closing) return;
    const value = Math.max(0, this.quoteSell(t, p.tokens) - this.cfg.priorityFeeSol);
    const ret = value / p.cost - 1;
    p.value = value; p.lastRet = ret; p.peakRet = Math.max(p.peakRet, ret);
    p.last = { vSol: t.vSol, vTok: t.vTok, price: t.price, migrated: t.migrated };
    if (t.migrated && now - t.lastTradeAt > 45_000 && now - (p.dexAt || 0) > 30_000 && this.dexPrice) {
      p.dexAt = now;
      this.dexPrice(t.mint).then((px) => { if (px) t.price = px; }).catch(() => {});
    }
    const f = this.market.features(t, now);
    const reason = exitReason({ ret, peakRet: p.peakRet, heldSec: (now - p.openedAt) / 1000, creatorSoldNow: t.creatorSold && !p.creatorSoldAtEntry, flow30: f.vel }, this.rule());
    if (reason) this.close(p, t, reason);
  }

  async close(p, t, reason) {
    if (p.closing) return;
    p.closing = true;
    let fill;
    try { fill = await this.broker.sell(t, p, this); } catch (e) { this.log('sell failed', p.symbol, e.message); p.closing = false; return; }
    const now = Date.now();
    const proceeds = fill.proceeds;
    const trade = {
      id: p.id, mint: p.mint, symbol: p.symbol, name: p.name, openedAt: p.openedAt, closedAt: now,
      cost: p.cost, proceeds, pnl: proceeds - p.cost, ret: proceeds / p.cost - 1, reason,
      holdSec: Math.round((now - p.openedAt) / 1000), signature: fill.signature || null, estimated: !!fill.estimated,
    };
    this.L.balance += proceeds;
    this.L.positions = this.L.positions.filter((x) => x.id !== p.id);
    this.L.trades.unshift(trade);
    if (this.L.trades.length > 1000) this.L.trades.length = 1000;
    this.L.daily.pnl += trade.pnl;
    this.log(`EXIT $${p.symbol} ${(trade.ret * 100).toFixed(1)}% (${reason})`);
    this.emit('exit', trade);
    this.sampleEquity();
    this.notifier.send(`${trade.pnl >= 0 ? '✅' : '🔻'} Sold $${p.symbol}: ${(trade.ret * 100).toFixed(1)}% (${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(4)} SOL), ${reason}`);
    this.checkBreaker();
    this.ledger.save();
  }

  /** Circuit breaker: stop buying for a while after a losing streak or a deep drawdown. */
  checkBreaker() {
    let streak = 0;
    for (const t of this.L.trades) { if (t.pnl < 0) streak++; else break; }
    const peak = this.L.ddPeak ?? Math.max(this.L.startBalance, ...this.L.equity.map((e) => e.v));
    const dd = peak > 0 ? 1 - this.equityNow() / peak : 0;
    let why = '';
    if (streak >= this.cfg.lossStreakPause) why = `${streak} losing trades in a row`;
    else if (dd >= this.cfg.maxDrawdownPct) why = `down ${(dd * 100).toFixed(0)}% from the best balance`;
    if (!why || (this.L.cooldownUntil || 0) > Date.now()) return;
    this.L.cooldownUntil = Date.now() + this.cfg.cooldownMin * 60_000;
    this.L.cooldownWhy = why;
    if (dd >= this.cfg.maxDrawdownPct) this.L.ddPeak = this.equityNow(); // measure the next drawdown from here
    this.log(`circuit breaker: ${why}, pausing buys for ${this.cfg.cooldownMin} min`);
    this.notifier.send(`⏸ Circuit breaker: ${why}. No new buys for ${this.cfg.cooldownMin} minutes. The team keeps watching and learning.`, { important: true });
  }

  // ---------- learning from shadow trades ----------
  addShadow(t, x, v, team) {
    t.shadowed = true;
    const size = this.cfg.tradeSizeSol;
    this.shadows.set(t.mint, {
      mint: t.mint, symbol: t.symbol, t0: Date.now(), x, team,
      cost: size + this.cfg.priorityFeeSol, tokens: this.quoteBuy(t, size),
      peakRet: 0, lastRet: 0, creatorSoldAtEntry: t.creatorSold, path: [[0, 0]], creatorSoldSec: null,
      scores: { scout: v.s.score, hunter: v.h.score, professor: v.pr.score },
      votes: { scout: v.s.vote, hunter: v.h.vote, professor: v.pr.vote },
    });
  }

  updateShadow(s, t, now) {
    const value = Math.max(0, this.quoteSell(t, s.tokens) - this.cfg.priorityFeeSol);
    const ret = value / s.cost - 1;
    const sec = (now - s.t0) / 1000;
    const last = s.path[s.path.length - 1];
    if ((sec - last[0] >= 5 || Math.abs(ret - last[1]) >= 0.03) && s.path.length < 260) s.path.push([Math.round(sec), +ret.toFixed(4)]);
    s.lastRet = ret; s.peakRet = Math.max(s.peakRet, ret);
    if (t.creatorSold && !s.creatorSoldAtEntry && s.creatorSoldSec == null) s.creatorSoldSec = sec;
    // Keep following past the current sell rule so the tuner can test other rules on this coin.
    if (sec >= this.cfg.shadowHorizonSec || ret <= -0.9) this.resolveShadow(s, ret, 'horizon');
  }

  resolveShadow(s, finalRet, reason) {
    if (!this.shadows.delete(s.mint)) return;
    const last = s.path[s.path.length - 1];
    if (last[1] !== +finalRet.toFixed(4)) s.path.push([Math.round((Date.now() - s.t0) / 1000), +finalRet.toFixed(4)]);
    // What the current sell rule would have made on this coin = the lesson for the brain.
    let path = s.path;
    if (s.creatorSoldSec != null) path = path.filter(([sec]) => sec <= s.creatorSoldSec);
    const ret = replay(path, this.rule());
    const y = ret > 0 ? 1 : 0;
    this.B.paths.push(s.path);
    if (this.B.paths.length > 450) this.B.paths.splice(0, this.B.paths.length - 450);
    this.B.recentY.push(y);
    if (this.B.recentY.length > 60) this.B.recentY.splice(0, this.B.recentY.length - 60);
    const prevMood = this.B.mood;
    this.B.mood = nextMood(prevMood, this.B.recentY.length >= 30 ? this.B.recentY.reduce((a, b) => a + b, 0) / this.B.recentY.length : null);
    if (prevMood !== this.B.mood) { this.log(`market mood: ${prevMood} → ${this.B.mood}`); this.notifier.send(`Market mood changed: ${prevMood} → ${this.B.mood}`, { important: true }); }
    this.learner.learn(s.x, y);
    const A = this.B.agents;
    for (const a of AGENTS) {
      const v = s.votes[a], st = A[a];
      if (v === 'buy') { st.calls++; st.buys++; if (y) { st.right++; st.buyWins++; } }
      else if (v === 'avoid') { st.calls++; if (!y) st.right++; }
    }
    if (s.team) { A.team.buys++; if (y) A.team.buyWins++; }
    this.B.samples.push({ p: s.scores.professor, scout: s.scores.scout, hunter: s.scores.hunter, ret: +ret.toFixed(4), x: s.x.map((v) => +v.toFixed(3)) });
    if (this.B.samples.length > 600) this.B.samples.splice(0, this.B.samples.length - 600);
    this.B.labels++;
    if (this.B.labels % 10 === 0) {
      this.B.curve.push({ t: Date.now(), acc: this.learner.accuracy(), n: this.learner.n });
      if (this.B.curve.length > 1500) this.B.curve.splice(0, this.B.curve.length - 1500);
    }
    if (this.B.labels % 20 === 0) this.retune();
    if (this.B.labels % 50 === 0) this.tuneExits();
    this.brain.save();
  }

  /** Move each agent's bar to wherever recent coins actually made money (never looser than a floor). */
  /**
   * The bar an agent uses right now: its learned bar, never above the owner's maximum, and relative —
   * a coin in the top TOP_PERCENT of recent scores passes even when the learned bar is higher.
   */
  bar(agent, score, extra = 0) {
    const arr = this.recentScores[agent];
    arr.push(score);
    if (arr.length > 400) arr.shift();
    let b = Math.min(this.B.thresholds[agent], this.cfg.maxBars[agent]);
    if (arr.length >= 80) {
      const sorted = [...arr].sort((x, y) => x - y);
      const topCut = sorted[Math.floor(sorted.length * (1 - this.cfg.topPercent))];
      b = Math.min(b, topCut);
    }
    return Math.min(0.95, b + extra);
  }

  retune() {
    const S = this.B.samples;
    if (S.length < 60) return;
    const best = (key, grid, floor) => {
      let pick = null;
      for (const thr of grid) {
        const sel = S.filter((s) => s[key] >= thr);
        if (sel.length < 8) continue;
        const ev = sel.reduce((a, s) => a + s.ret, 0) / sel.length;
        if (!pick || ev > pick.ev) pick = { thr, ev };
      }
      return pick ? Math.max(floor, pick.thr) : null;
    };
    const g = (a, b) => Array.from({ length: Math.round((b - a) / 0.05) + 1 }, (_, i) => +(a + i * 0.05).toFixed(2));
    const th = this.B.thresholds;
    const mb = this.cfg.maxBars;
    th.scout = Math.min(mb.scout, best('scout', g(0.25, 0.85), 0.25) ?? th.scout);
    th.hunter = Math.min(mb.hunter, best('hunter', g(0.1, 0.75), 0.1) ?? th.hunter);
    th.professor = Math.min(mb.professor, best('p', g(0.2, 0.85), 0.2) ?? th.professor);
  }

  /** Try every sell rule in the grid on recorded coins; adopt a better one only if it holds up on the newest coins. */
  tuneExits() {
    if (!this.cfg.autoTuneExits) return;
    const res = optimizeExits(this.B.paths, this.rule(), this.cfg.maxTakeProfit);
    if (!res) return;
    this.B.exitTune = { ...res, at: Date.now() };
    if (res.accepted) {
      const r = res.rule;
      const changed = JSON.stringify(r) !== JSON.stringify(this.B.exitRule);
      this.B.exitRule = r;
      if (changed) {
        const msg = `sell rule tuned: take profit +${r.takeProfit * 100}%, stop loss -${r.stopLoss * 100}%, trailing ${r.trailing * 100}%, max hold ${r.maxHoldMin} min`;
        this.log(msg);
        this.notifier.send(`🧠 New ${msg}`, { important: true });
      }
    }
  }

  analysis() {
    if (this.analysisCache && Date.now() - this.analysisCache.at < 60_000) return this.analysisCache.data;
    const rets = this.L.trades.map((t) => t.ret);
    const data = {
      edge: bootstrapEdge(rets),
      metrics: tradeMetrics(this.L.trades, this.L.equity, this.L.startBalance),
      signals: signalHealth(this.B.samples),
      walkForward: walkForward(this.learner.recent),
      mood: this.B.mood,
      rule: this.rule(),
      ruleTuned: !!(this.cfg.autoTuneExits && this.B.exitRule),
      exitTune: this.B.exitTune,
      paths: this.B.paths.length,
      breaker: (this.L.cooldownUntil || 0) > Date.now() ? { until: this.L.cooldownUntil, why: this.L.cooldownWhy } : null,
      alerts: this.notifier.enabled,
    };
    this.analysisCache = { at: Date.now(), data };
    return data;
  }

  // ---------- dashboard data ----------
  pushRadar(t, f, v, decision, blocked) {
    const now = Date.now();
    const interesting = decision !== 'pass' || v.s.vote === 'buy';
    if (!interesting && now - this.lastQuietRadar < 1200) return;
    if (!interesting) this.lastQuietRadar = now;
    const item = {
      at: now, mint: t.mint, symbol: t.symbol, name: t.name, age: Math.round(f.age),
      mcapUsd: Math.round(t.mcapSol * this.sol.usd), buyers: f.buyers,
      votes: { scout: v.s.vote, hunter: v.h.vote, professor: v.pr.vote },
      scores: { scout: +v.s.score.toFixed(2), hunter: +v.h.score.toFixed(2), professor: +v.pr.score.toFixed(2) },
      thoughts: { scout: v.s.thought, hunter: v.h.thought, professor: v.pr.thought },
      decision, blocked,
    };
    this.radar.unshift(item);
    if (this.radar.length > 40) this.radar.length = 40;
    this.emit('radar', item);
  }

  publicPos(p, now) {
    const { last, x, closing, dexAt, ...rest } = p;
    return { ...rest, heldSec: Math.round((now - p.openedAt) / 1000) };
  }

  equityNow() { return this.L.balance + this.L.positions.reduce((a, p) => a + (p.value ?? p.cost), 0); }

  sampleEquity() {
    const E = this.L.equity;
    const v = +this.equityNow().toFixed(5);
    E.push({ t: Date.now(), v });
    if (this.L.ddPeak != null) this.L.ddPeak = Math.max(this.L.ddPeak, v);
    if (E.length > 4000) { const half = E.splice(0, 2000); E.unshift(...half.filter((_, i) => i % 2 === 0)); }
  }

  persist() { this.B.learner = this.learner.toJSON(); this.brain.save(); this.ledger.save(); }

  async control(action) {
    if (action === 'pause') this.L.paused = true;
    else if (action === 'resume') { this.L.paused = false; this.broker.errors = 0; this.L.cooldownUntil = 0; }
    else if (action === 'closeAll') {
      for (const p of [...this.L.positions]) { const t = this.market.tokens.get(p.mint); if (t) await this.close(p, t, 'closed by you'); }
    } else return { ok: false, error: 'Unknown action' };
    this.ledger.save();
    return { ok: true, paused: this.L.paused };
  }

  snapshot(full) {
    const now = Date.now();
    const trades = this.L.trades;
    const wins = trades.filter((t) => t.pnl > 0).length;
    const eq = this.equityNow();
    const A = this.B.agents;
    const acc = (a) => (A[a].calls ? A[a].right / A[a].calls : null);
    const snap = {
      mode: this.cfg.mode, feed: this.feedStatus, paused: this.L.paused, startedAt: this.startedAt, now,
      solUsd: this.sol.usd, hunterSource: this.hunter.source, controlsEnabled: !!this.cfg.password,
      liveReady: this.broker.ready, wallet: this.wallet,
      balance: this.L.balance, startBalance: this.L.startBalance, equity: eq,
      pnl: eq - this.L.startBalance, pnlPct: eq / this.L.startBalance - 1, todayPnl: this.L.daily.pnl,
      stats: {
        trades: trades.length, wins, winRate: trades.length ? wins / trades.length : null,
        avgRet: trades.length ? trades.reduce((a, t) => a + t.ret, 0) / trades.length : null,
        best: trades.reduce((a, t) => Math.max(a, t.ret), -Infinity),
        worst: trades.reduce((a, t) => Math.min(a, t.ret), Infinity),
      },
      positions: this.L.positions.map((p) => this.publicPos(p, now)),
      agents: {
        scout: { accuracy: acc('scout'), calls: A.scout.calls, threshold: this.B.thresholds.scout },
        hunter: { accuracy: acc('hunter'), calls: A.hunter.calls, threshold: this.B.thresholds.hunter },
        professor: { accuracy: acc('professor'), calls: A.professor.calls, threshold: this.B.thresholds.professor },
        team: { buys: A.team.buys, winRate: A.team.buys ? A.team.buyWins / A.team.buys : null },
      },
      learning: { samples: this.learner.n, accuracy: this.learner.accuracy(), watching: this.shadows.size },
      counters: { ...this.L.counters, tracked: this.market.tokens.size },
      meta: this.metaStats ? { ...this.metaStats } : null,
      config: { tradeSizeSol: this.cfg.tradeSizeSol, ...this.rule(), maxOpen: this.cfg.maxOpen, dailyLossLimitSol: this.cfg.dailyLossLimitSol },
    };
    if (full) {
      snap.trades = trades.slice(0, 60);
      snap.radar = this.radar;
      const E = this.L.equity, step = Math.max(1, Math.ceil(E.length / 600));
      snap.equitySeries = E.filter((_, i) => i % step === 0 || i === E.length - 1);
      snap.learning.curve = this.B.curve.slice(-300);
      snap.learning.factors = this.learner.n >= 30 ? this.learner.factors().slice(0, 7) : [];
      snap.analysis = this.analysis();
    }
    return snap;
  }
}
