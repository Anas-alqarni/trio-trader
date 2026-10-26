import { EventEmitter } from 'node:events';

/**
 * Live pump.fun data from PumpPortal's free WebSocket.
 * One connection only (PumpPortal asks for that); subscriptions are batched.
 * Emits: 'create' (new coin), 'trade' (buy/sell), 'migrate', 'status'.
 */
export class PumpPortalFeed extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.url = 'wss://pumpportal.fun/api/data';
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
    setInterval(() => this.flush(), 300);
    // Watchdog: if the stream goes silent, reconnect.
    setInterval(() => {
      if (this.status === 'live' && Date.now() - this.lastMsgAt > 60_000) {
        this.log('feed silent for 60s, reconnecting');
        try { this.ws.close(); } catch { /* ignore */ }
      }
    }, 15_000);
  }

  setStatus(s) { this.status = s; this.emit('status', s); }

  connect() {
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.log('feed error', e.message); return this.retry(); }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.backoff = 1000;
      this.lastMsgAt = Date.now();
      this.setStatus('live');
      this.log('connected to pump.fun live feed');
      this.raw({ method: 'subscribeNewToken' });
      this.raw({ method: 'subscribeMigration' });
      if (this.subs.size) this.raw({ method: 'subscribeTokenTrade', keys: [...this.subs] });
    });
    ws.addEventListener('message', (ev) => {
      this.lastMsgAt = Date.now();
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (!m || m.message || m.errors) return; // acks / notices
      if (m.txType === 'create') this.emit('create', m);
      else if (m.txType === 'buy' || m.txType === 'sell') this.emit('trade', m);
      else if (m.txType === 'migrate' || (m.mint && !m.txType && m.pool)) this.emit('migrate', m);
    });
    ws.addEventListener('close', () => this.retry());
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
  }

  retry() {
    if (this.status === 'reconnecting') return;
    this.setStatus('reconnecting');
    setTimeout(() => { this.status = 'connecting'; this.connect(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  raw(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  subscribe(mints) {
    for (const m of mints) if (!this.subs.has(m)) { this.subs.add(m); this.pendingSub.add(m); this.pendingUnsub.delete(m); }
  }
  unsubscribe(mints) {
    for (const m of mints) if (this.subs.has(m)) { this.subs.delete(m); this.pendingUnsub.add(m); this.pendingSub.delete(m); }
  }
  flush() {
    if (this.pendingSub.size) { this.raw({ method: 'subscribeTokenTrade', keys: [...this.pendingSub] }); this.pendingSub.clear(); }
    if (this.pendingUnsub.size) { this.raw({ method: 'unsubscribeTokenTrade', keys: [...this.pendingUnsub] }); this.pendingUnsub.clear(); }
  }
}
