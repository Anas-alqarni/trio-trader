/** Practice trading: fills at real (or simulated) pump.fun prices including fees, slippage and a delay penalty. */
export class PaperBroker {
  constructor() { this.kind = 'paper'; this.ready = true; this.errors = 0; }
  async buy(t, size, eng) { return { tokens: eng.quoteBuy(t, size), estimated: false }; }
  async sell(t, p, eng) { return { proceeds: Math.max(0, eng.quoteSell(t, p.tokens) - eng.cfg.priorityFeeSol), estimated: false }; }
  async walletBalance() { return null; }
}
