/**
 * REAL MONEY trading through PumpPortal's Lightning API (https://pumpportal.fun).
 * Only used when LIVE_TRADING=true AND PUMPPORTAL_API_KEY is set.
 * PumpPortal holds the trading wallet tied to that key; fund it with only what you can lose.
 * Fills are estimated from the bonding curve; set WALLET_PUBLIC_KEY to show the true wallet balance.
 */
export class LiveBroker {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.kind = 'live';
    this.ready = !!cfg.pumpPortalKey;
    this.errors = 0;
  }

  async trade(body) {
    const r = await fetch(`https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(this.cfg.pumpPortalKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    const errs = Array.isArray(j.errors) ? j.errors : j.errors ? [j.errors] : [];
    if (!r.ok || errs.length || !j.signature) {
      this.errors++;
      throw new Error(errs.join('; ') || `HTTP ${r.status}`);
    }
    this.errors = 0;
    return j.signature;
  }

  async buy(t, size, eng) {
    const signature = await this.trade({
      action: 'buy', mint: t.mint, amount: size, denominatedInSol: 'true',
      slippage: this.cfg.slippagePct, priorityFee: this.cfg.priorityFeeSol, pool: 'auto',
    });
    this.log(`LIVE BUY ${t.symbol} ${size} SOL → ${signature}`);
    return { tokens: eng.quoteBuy(t, size), signature, estimated: true };
  }

  async sell(t, p, eng) {
    const signature = await this.trade({
      action: 'sell', mint: t.mint, amount: '100%', denominatedInSol: 'false',
      slippage: this.cfg.slippagePct, priorityFee: this.cfg.priorityFeeSol, pool: 'auto',
    });
    this.log(`LIVE SELL ${t.symbol} → ${signature}`);
    return { proceeds: Math.max(0, eng.quoteSell(t, p.tokens) - this.cfg.priorityFeeSol), signature, estimated: true };
  }

  async walletBalance() {
    if (!this.cfg.walletPublicKey) return null;
    try {
      const r = await fetch(this.cfg.solanaRpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [this.cfg.walletPublicKey] }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      return j?.result?.value != null ? j.result.value / 1e9 : null;
    } catch { return null; }
  }
}
