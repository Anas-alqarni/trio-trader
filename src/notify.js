/**
 * Telegram alerts (optional). Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
 * Create a bot with @BotFather, send it any message, then get your chat id from
 * https://api.telegram.org/bot<token>/getUpdates
 */
export class Notifier {
  constructor(cfg, log) {
    this.token = cfg.telegramToken;
    this.chat = cfg.telegramChat;
    this.log = log;
    this.enabled = !!(this.token && this.chat);
    this.sent = [];
  }
  async send(text) {
    if (!this.enabled) return;
    const now = Date.now();
    this.sent = this.sent.filter((t) => now - t < 60_000);
    if (this.sent.length >= 15) return; // stay well under Telegram's limits
    this.sent.push(now);
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) this.log('Telegram error', r.status);
    } catch (e) { this.log('Telegram failed', e.message); }
  }
}
