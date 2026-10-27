/**
 * WhatsApp alerts through CallMeBot's free personal API (https://www.callmebot.com).
 * Setup: add +34 694 25 79 52 to your contacts, send it "I allow callmebot to send me messages"
 * on WhatsApp, and it replies with your API key. Then set WHATSAPP_PHONE (with country code,
 * e.g. +9665XXXXXXXX) and WHATSAPP_APIKEY.
 *
 * The free service is for light personal use, so alerts are queued, bundled together and sent
 * at most once every 20 seconds. WHATSAPP_ALERTS=important sends only the big moments.
 */
export class Notifier {
  constructor(cfg, log) {
    this.phone = cfg.whatsappPhone;
    this.key = cfg.whatsappKey;
    this.level = cfg.whatsappLevel;
    this.log = log;
    this.enabled = !!(this.phone && this.key);
    this.queue = [];
    this.lastSent = 0;
    if (this.enabled) setInterval(() => this.flush(), 5000);
  }

  /** important = circuit breaker, tuned rules, mood, daily summary, start-up. */
  send(text, { important = false } = {}) {
    if (!this.enabled) return;
    if (this.level === 'important' && !important) return;
    this.queue.push(text);
    if (this.queue.length > 30) this.queue.splice(0, this.queue.length - 30);
  }

  async flush() {
    if (!this.queue.length || Date.now() - this.lastSent < 20_000) return;
    let body = this.queue.splice(0, 8).join('\n\n');
    if (this.queue.length) body += `\n\n(+${this.queue.length} more in the next message)`;
    if (body.length > 1500) body = body.slice(0, 1490) + '…';
    this.lastSent = Date.now();
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(this.phone)}&text=${encodeURIComponent('Trio Trader\n' + body)}&apikey=${encodeURIComponent(this.key)}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) this.log('WhatsApp alert failed', r.status, (await r.text()).slice(0, 120));
    } catch (e) { this.log('WhatsApp alert failed', e.message); }
  }
}
