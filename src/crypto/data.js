// Market data for the crypto team.
// Live: Coinbase Exchange public candles (free, no key) + the Crypto Fear & Greed Index (alternative.me, free).
// Test: SimCandles makes up realistic-looking candles so the whole bot can be tested offline.

export const COINS = [
  ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['SOL-USD', 'Solana'], ['XRP-USD', 'XRP'],
  ['DOGE-USD', 'Dogecoin'], ['ADA-USD', 'Cardano'], ['AVAX-USD', 'Avalanche'], ['LINK-USD', 'Chainlink'],
  ['LTC-USD', 'Litecoin'], ['BCH-USD', 'Bitcoin Cash'], ['DOT-USD', 'Polkadot'], ['SUI-USD', 'Sui'],
];

/** Candles oldest-first: { t (ms, candle start), o, h, l, c, v }. The last one may still be forming. */
export class CoinbaseData {
  constructor(log, candleSec = 300) {
    this.log = log;
    this.candleSec = candleSec;
    this.bad = new Set();
    this.stats = { calls: 0, errors: 0 };
    this.fg = null;
  }
  async candles(product) {
    if (this.bad.has(product)) return null;
    this.stats.calls++;
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${this.candleSec}`, {
        headers: { 'user-agent': 'trio-trader/1.0' }, signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 404 || r.status === 400) { this.bad.add(product); this.log(`${product} is not on Coinbase, skipping it`); return null; }
      if (!r.ok) { this.stats.errors++; return null; }
      const rows = await r.json();
      if (!Array.isArray(rows)) return null;
      return rows.map(([t, l, h, o, c, v]) => ({ t: t * 1000, o, h, l, c, v })).sort((a, b) => a.t - b.t);
    } catch { this.stats.errors++; return null; }
  }
  async fearGreed() {
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      const d = j?.data?.[0];
      if (d) this.fg = { value: +d.value, label: d.value_classification };
    } catch { /* keep last */ }
    return this.fg;
  }
}

/** Offline stand-in: random-walk prices with changing trends, one candle every candleSec seconds. */
export class SimCandles {
  constructor(candleSec = 3) {
    this.candleSec = candleSec;
    this.stats = { calls: 0, errors: 0 };
    this.fg = { value: 50, label: 'Neutral' };
    this.series = new Map();
    const base = { 'BTC-USD': 70000, 'ETH-USD': 3000, 'SOL-USD': 150, 'XRP-USD': 0.6, 'DOGE-USD': 0.15, 'ADA-USD': 0.45 };
    const now = Date.now(), ms = candleSec * 1000;
    for (const [p] of COINS) {
      const arr = [];
      let price = base[p] || 10 + Math.random() * 40, drift = 0;
      for (let i = 300; i > 0; i--) { const c = this.next(price, drift, now - i * ms); arr.push(c); price = c.c; if (Math.random() < 0.05) drift = (Math.random() - 0.5) * 0.004; }
      this.series.set(p, { arr, drift, beta: p === 'BTC-USD' ? 1 : 0.6 + Math.random() * 0.8 });
    }
    this.marketDrift = 0;
  }
  next(price, drift, t) {
    const vol = 0.003;
    const z = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    const c = price * Math.exp(drift + vol * z());
    const h = Math.max(price, c) * (1 + Math.abs(z()) * vol * 0.4), l = Math.min(price, c) * (1 - Math.abs(z()) * vol * 0.4);
    return { t, o: price, h, l, c, v: 100 * (1 + Math.abs(z())) * (1 + Math.abs(drift) * 300) };
  }
  advance() {
    const ms = this.candleSec * 1000, now = Date.now();
    if (Math.random() < 0.03) this.marketDrift = (Math.random() - 0.5) * 0.003;
    for (const s of this.series.values()) {
      while (s.arr[s.arr.length - 1].t + ms <= now) {
        if (Math.random() < 0.04) s.drift = (Math.random() - 0.5) * 0.004;
        const last = s.arr[s.arr.length - 1];
        s.arr.push(this.next(last.c, s.drift * 0.6 + this.marketDrift * s.beta, last.t + ms));
        if (s.arr.length > 300) s.arr.shift();
      }
    }
  }
  async candles(product) { this.stats.calls++; this.advance(); return this.series.get(product)?.arr.map((x) => ({ ...x })) || null; }
  async fearGreed() { this.fg = { value: Math.max(5, Math.min(95, this.fg.value + (Math.random() - 0.5) * 6)), label: 'Simulated' }; return this.fg; }
}
