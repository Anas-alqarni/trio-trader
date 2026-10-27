import { EventEmitter } from 'node:events';

/**
 * Live pump.fun data from PumpPortal's free WebSocket.
 * One connection only (PumpPortal asks for that); subscriptions are batched.
 * Emits: 'create' (new coin), 'trade' (buy/sell), 'migrate', 'status'.
 */
export class PumpPortalFeed extends EventEmitter {
  constructor(log, cfg = {}) {
    super();
    this.log = log;
    // New coins are free. Per-coin trades need a funded PumpPortal key (metered), so by default
    // trades come from DexScreener's free API instead (see DexPoller below).
    this.paidTrades = cfg.tradeData === 'pumpportal' && !!cfg.pumpPortalKey;
    this.url = (cfg.feedUrl || 'wss://pumpportal.fun/api/data') + (this.paidTrades ? `?api-key=${encodeURIComponent(cfg.pumpPortalKey)}` : '');
    this.poller = this.paidTrades ? null : new DexPoller(this, log, cfg);
    this.subs = new Set();
    this.pendingSub = new Set();
    this.pendingUnsub = new Set();
    this.ws = null;
    this.status = 'connecting';
    this.backoff = 1000;
    this.lastMsgAt = Date.now();
  }

  start() {
    this.connect();
    if (this.poller) this.poller.start();
    setInterval(() => this.flush(), 300);
    // Watchdog: reconnect if the stream goes silent, or if we have not been live for 45s for any reason
    // (a connection attempt that hangs never fires "close", which used to leave the bot stuck on "connecting").
    setInterval(() => {
      const now = Date.now();
      if (this.status === 'live' && now - this.lastMsgAt > 60_000) { this.log('feed silent for 60s, reconnecting'); this.reconnect(); }
      else if (this.status !== 'live' && now - this.statusAt > 45_000) { this.log(`feed stuck "${this.status}" for 45s, reconnecting`); this.reconnect(true); }
    }, 15_000);
  }

  setStatus(s) { this.status = s; this.statusAt = Date.now(); this.emit('status', s); }

  connect() {
    const gen = (this.gen = (this.gen || 0) + 1); // events from older sockets are ignored
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.log('feed error', e.message); return this.scheduleRetry(gen); }
    this.ws = ws;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (gen === this.gen && this.status !== 'live') { this.log('feed connection timed out'); this.reconnect(); }
    }, 15_000);
    ws.addEventListener('open', () => {
      if (gen !== this.gen) return;
      clearTimeout(this.connectTimer);
      this.backoff = 1000;
      this.lastMsgAt = Date.now();
      this.setStatus('live');
      this.log('connected to pump.fun live feed');
      this.raw({ method: 'subscribeNewToken' });
      this.raw({ method: 'subscribeMigration' });
      if (this.paidTrades && this.subs.size) this.raw({ method: 'subscribeTokenTrade', keys: [...this.subs] });
    });
    ws.addEventListener('message', (ev) => {
      if (gen !== this.gen) return;
      this.lastMsgAt = Date.now();
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (!m || m.message || m.errors) return; // acks / notices
      if (m.txType === 'create') this.emit('create', m);
      else if (m.txType === 'buy' || m.txType === 'sell') this.emit('trade', m);
      else if (m.txType === 'migrate' || (m.mint && !m.txType && m.pool)) this.emit('migrate', m);
    });
    ws.addEventListener('close', (ev) => { if (gen === this.gen) { this.log(`feed closed (code ${ev.code})`); this.scheduleRetry(gen); } });
    ws.addEventListener('error', () => { if (gen === this.gen) { try { ws.close(); } catch { /* ignore */ } this.scheduleRetry(gen); } });
  }

  /** Drop the current socket and start a fresh one right away (or after the backoff). */
  reconnect(withBackoff = false) {
    const old = this.ws;
    this.gen = (this.gen || 0) + 1; // detach the old socket's events
    try { old?.close(); } catch { /* ignore */ }
    clearTimeout(this.retryTimer);
    if (withBackoff) this.scheduleRetry(this.gen); else this.connect();
  }

  scheduleRetry(gen) {
    if (gen !== this.gen || this.retryTimer && this.retryPending) return;
    this.setStatus('reconnecting');
    this.retryPending = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryPending = false; this.connect(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  raw(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  subscribe(mints) {
    if (this.poller) return this.poller.add(mints);
    for (const m of mints) if (!this.subs.has(m)) { this.subs.add(m); this.pendingSub.add(m); this.pendingUnsub.delete(m); }
  }
  unsubscribe(mints) {
    if (this.poller) return this.poller.remove(mints);
    for (const m of mints) if (this.subs.has(m)) { this.subs.delete(m); this.pendingUnsub.add(m); this.pendingSub.delete(m); }
  }
  flush() {
    if (this.pendingSub.size) { this.raw({ method: 'subscribeTokenTrade', keys: [...this.pendingSub] }); this.pendingSub.clear(); }
    if (this.pendingUnsub.size) { this.raw({ method: 'unsubscribeTokenTrade', keys: [...this.pendingUnsub] }); this.pendingUnsub.clear(); }
  }
}

// Virtual reserves of the pump.fun curve multiply to a constant, so price alone gives both reserves.
const K = 30 * 1_073_000_000;

/**
 * Free per-coin trade data from DexScreener. Every few seconds it asks for up to 30 coins at once,
 * compares buy/sell counts and volume with the last answer, and turns the difference into trade
 * messages in the same shape PumpPortal uses, so the rest of the bot doesn't change.
 * Limits: no wallet-level detail (creator sells and whale wallets aren't visible this way).
 */
export class DexPoller {
  constructor(feed, log, cfg) {
    this.feed = feed;
    this.log = log;
    this.cfg = cfg;
    this.mints = new Set();
    this.last = new Map();
    this.stats = { calls: 0, found: 0, errors: 0 };
    this.blockedUntil = 0;
    this.solUsd = () => cfg.solUsd?.() || 150;
  }
  add(mints) { for (const m of mints) this.mints.add(m); }
  remove(mints) { for (const m of mints) { this.mints.delete(m); this.last.delete(m); } }
  start() {
    let busy = false;
    setInterval(async () => {
      if (busy || Date.now() < this.blockedUntil || !this.mints.size) return;
      busy = true;
      try { await this.cycle(); } finally { busy = false; }
    }, 6000);
  }
  async cycle() {
    const all = [...this.mints];
    for (let i = 0; i < all.length; i += 30) {
      if (Date.now() < this.blockedUntil) return;
      await this.fetchBatch(all.slice(i, i + 30));
    }
  }
  async fetchBatch(batch) {
    this.stats.calls++;
    let pairs;
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 429) { this.blockedUntil = Date.now() + 60_000; this.log('DexScreener rate limit, pausing 60s'); return; }
      if (!r.ok) { this.stats.errors++; return; }
      pairs = await r.json();
    } catch { this.stats.errors++; return; }
    if (!Array.isArray(pairs)) return;
    // Keep the most liquid SOL pair per coin.
    const best = new Map();
    for (const p of pairs) {
      const mint = p?.baseToken?.address;
      if (!mint || !this.mints.has(mint) || p.quoteToken?.symbol !== 'SOL') continue;
      const cur = best.get(mint);
      if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(mint, p);
    }
    for (const [mint, p] of best) { this.stats.found++; this.apply(mint, p); }
  }
  apply(mint, p) {
    const price = +p.priceNative;
    if (!(price > 0)) return;
    const buys = +p.txns?.h24?.buys || 0, sells = +p.txns?.h24?.sells || 0;
    const volSol = (+p.volume?.h24 || 0) / this.solUsd();
    const first = !this.last.has(mint);
    const prev = this.last.get(mint) || { buys: 0, sells: 0, volSol: 0 };
    this.last.set(mint, { buys, sells, volSol });
    const db = Math.max(0, buys - prev.buys), ds = Math.max(0, sells - prev.sells);
    const dv = Math.max(0, volSol - prev.volSol);
    const onCurve = p.dexId === 'pumpfun';
    if (!onCurve) this.feed.emit('migrate', { mint, txType: 'migrate' });
    const res = onCurve ? { vSolInBondingCurve: Math.sqrt(K * price), vTokensInBondingCurve: Math.sqrt(K / price) } : {};
    const mcapSol = price * 1e9;
    if (!db && !ds) { // price may still have moved
      this.feed.emit('trade', { mint, txType: 'buy', count: 0, solAmount: 0, tokenAmount: 0, synthetic: true, marketCapSol: mcapSol, ...res });
      return;
    }
    const share = db + ds ? db / (db + ds) : 0;
    if (db) this.feed.emit('trade', { mint, txType: 'buy', count: db, solAmount: dv * share, tokenAmount: (dv * share) / price, synthetic: true, first, marketCapSol: mcapSol, ...res });
    if (ds) this.feed.emit('trade', { mint, txType: 'sell', count: ds, solAmount: dv * (1 - share), tokenAmount: (dv * (1 - share)) / price, synthetic: true, first, marketCapSol: mcapSol, ...res });
  }
}
