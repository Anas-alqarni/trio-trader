import fs from 'node:fs';
import path from 'node:path';

/**
 * Phone alerts. Telegram (preferred) and/or WhatsApp via CallMeBot.
 *
 * Telegram setup: in Telegram talk to @BotFather → /newbot → copy the token → set TELEGRAM_BOT_TOKEN.
 * Then open your new bot and send it /start. The bot remembers your chat by itself (saved on the disk),
 * so TELEGRAM_CHAT_ID is optional.
 *
 * Alerts are queued and bundled so your phone isn't flooded. ALERTS=important sends only the big moments.
 */
export class Notifier {
  constructor(cfg, log) {
    this.log = log;
    this.level = (cfg.alertLevel || cfg.whatsappLevel || 'all').toLowerCase();
    this.queue = [];
    this.lastSent = 0;
    // Telegram
    this.tgToken = cfg.telegramToken || '';
    this.tgFile = path.join(cfg.dataDir || './data', 'telegram.json');
    this.tgChat = cfg.telegramChat || this.loadChat();
    this.tgOffset = 0;
    // WhatsApp (CallMeBot)
    this.waPhone = cfg.whatsappPhone || '';
    this.waKey = cfg.whatsappKey || '';
    this.enabled = !!this.tgToken || !!(this.waPhone && this.waKey);
    this.channel = this.tgToken ? 'Telegram' : this.enabled ? 'WhatsApp' : 'off';
    if (this.tgToken && !this.tgChat) { this.log('Telegram: waiting for you to send /start to your bot'); this.pollTimer = setInterval(() => this.findChat(), 8000); this.findChat(); }
    if (this.enabled) setInterval(() => this.flush(), 3000);
  }

  loadChat() { try { return JSON.parse(fs.readFileSync(this.tgFile, 'utf8')).chatId || ''; } catch { return ''; } }

  /** Look at the bot's inbox for the first message, and remember who sent it. */
  async findChat() {
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.tgToken}/getUpdates?offset=${this.tgOffset}&timeout=0`, { signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      if (!j.ok) { if (j.error_code === 401) { this.log('Telegram: the bot token is wrong'); clearInterval(this.pollTimer); } return; }
      for (const u of j.result || []) {
        this.tgOffset = u.update_id + 1;
        const chat = u.message?.chat || u.channel_post?.chat;
        if (chat?.id && !this.tgChat) {
          this.tgChat = String(chat.id);
          try { fs.mkdirSync(path.dirname(this.tgFile), { recursive: true }); fs.writeFileSync(this.tgFile, JSON.stringify({ chatId: this.tgChat })); } catch { /* ignore */ }
          clearInterval(this.pollTimer);
          this.log(`Telegram connected to chat ${this.tgChat}`);
          this.queue.unshift('✅ Connected! You will get the team\'s buys, sells and daily summary here.');
        }
      }
    } catch { /* try again later */ }
  }

  /** important = circuit breaker, tuned rules, mood, daily summary, start-up. */
  send(text, { important = false } = {}) {
    if (!this.enabled) return;
    if (this.level === 'important' && !important) return;
    this.queue.push(text);
    if (this.queue.length > 40) this.queue.splice(0, this.queue.length - 40);
  }

  async flush() {
    if (!this.queue.length) return;
    const gap = this.tgToken ? 3000 : 20_000;
    if (Date.now() - this.lastSent < gap) return;
    if (this.tgToken && !this.tgChat) return; // wait until you message the bot
    let body = this.queue.splice(0, 10).join('\n\n');
    if (this.queue.length) body += `\n\n(+${this.queue.length} more coming)`;
    if (body.length > 3500) body = body.slice(0, 3490) + '…';
    this.lastSent = Date.now();
    if (this.tgToken) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${this.tgToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.tgChat, text: body, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) this.log('Telegram alert failed', r.status, (await r.text()).slice(0, 160));
      } catch (e) { this.log('Telegram alert failed', e.message); }
    }
    if (this.waPhone && this.waKey && !this.tgToken) {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(this.waPhone)}&text=${encodeURIComponent('Trio Trader\n' + body)}&apikey=${encodeURIComponent(this.waKey)}`;
      try { const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }); if (!r.ok) this.log('WhatsApp alert failed', r.status); } catch (e) { this.log('WhatsApp alert failed', e.message); }
    }
  }
}
