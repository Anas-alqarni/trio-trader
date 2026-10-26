import { clamp, fmtK } from '../util.js';

const HYPE = /\b(100x|1000x|moon(ing)?|presale|airdrop|guaranteed|don'?t\s+miss|send\s+it|next\s+(pepe|doge|bonk|wif))\b/i;

export function parseTwitter(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/(?:twitter\.com|x\.com)\/([^/?#]+)(?:\/([^/?#]+))?(?:\/([^/?#]+))?/i);
  if (!m) return null;
  if (m[1] === 'i' && m[2] === 'communities') return { kind: 'community', handle: 'community:' + (m[3] || '') };
  if (m[2] === 'status') return { kind: 'tweet', handle: m[1].toLowerCase() };
  if (['home', 'search', 'intent', 'share', 'i'].includes(m[1].toLowerCase())) return null;
  return { kind: 'profile', handle: m[1].toLowerCase() };
}

/**
 * HUNTER — checks the coin's social side and what people say on X.
 * Sources, best first: X API (X_BEARER_TOKEN) → Claude web search of X (ANTHROPIC_API_KEY) → pump.fun links only.
 * The expensive look at X only happens for coins the Scout already likes.
 */
export class Hunter {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.handleMints = new Map();
    this.cache = new Map();
    this.llmCalls = [];
    this.xBlockedUntil = 0;
    this.source = cfg.simulate ? 'simulated X' : cfg.xBearer ? 'X API' : cfg.anthropicKey ? 'Claude searching X' : 'pump.fun social links';
  }

  register(t) {
    const tw = parseTwitter(t.meta?.twitter);
    if (!tw || tw.kind === 'tweet') return;
    if (!this.handleMints.has(tw.handle)) this.handleMints.set(tw.handle, new Set());
    this.handleMints.get(tw.handle).add(t.mint);
    if (this.handleMints.size > 8000) this.handleMints.delete(this.handleMints.keys().next().value);
  }

  quick(t) {
    if (!t.meta) return { score: 0.12, critical: '', flags: [], thought: 'No social links found yet' };
    const m = t.meta, flags = [];
    const tw = parseTwitter(m.twitter);
    let s = 0;
    if (tw) s += tw.kind === 'profile' ? 0.3 : tw.kind === 'community' ? 0.25 : 0.15;
    if (m.telegram) s += 0.12;
    if (m.website) s += 0.13;
    if ((m.description || '').length > 25) s += 0.1;
    const reuse = tw && tw.kind !== 'tweet' ? this.handleMints.get(tw.handle)?.size || 1 : 0;
    if (reuse > 1) flags.push(`X account reused by ${reuse} launches`);
    else if (tw) s += 0.2;
    if (HYPE.test(m.description || '')) flags.push('hype words in the description');
    const parts = [];
    if (tw) parts.push(tw.kind === 'tweet' ? `points to @${tw.handle}'s post` : tw.kind === 'community' ? 'X community' : `X @${tw.handle}`);
    if (m.telegram) parts.push('Telegram');
    if (m.website) parts.push('website');
    const critical = reuse > 2 ? `same X account used by ${reuse} coins (serial launcher)` : '';
    return {
      score: clamp(s - flags.length * 0.18),
      critical,
      flags,
      thought: critical ? `Pass: ${critical}` : parts.length ? parts.join(' · ') + (flags.length ? ` · ⚠ ${flags[0]}` : '') : 'Anonymous launch, no socials',
    };
  }

  budgetOk() {
    const hour = Date.now() - 3600_000;
    this.llmCalls = this.llmCalls.filter((t) => t > hour);
    return this.llmCalls.length < this.cfg.hunterLlmPerHour;
  }

  async deep(t) {
    const q = this.quick(t);
    if (this.cache.has(t.mint)) return this.merge(q, this.cache.get(t.mint));
    let x = null;
    try {
      if (this.cfg.simulate) x = this.simX(t);
      else if (this.cfg.xBearer && Date.now() > this.xBlockedUntil) x = await this.xSearch(t);
      else if (this.cfg.anthropicKey && this.budgetOk()) x = await this.llmSearch(t);
    } catch (e) { this.log('hunter X check failed:', e.message); }
    if (!x) return q;
    this.cache.set(t.mint, x);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
    return this.merge(q, x);
  }

  merge(q, x) {
    return {
      score: clamp(0.35 * q.score + 0.65 * x.score - x.flags.length * 0.1),
      critical: q.critical || x.critical || '',
      flags: [...q.flags, ...x.flags],
      thought: q.critical ? q.thought : x.thought,
    };
  }

  simX(t) {
    const linked = !!parseTwitter(t.meta?.twitter);
    const posts = linked ? Math.round(Math.random() * 14) : Math.round(Math.random() * 3);
    const big = linked && Math.random() < 0.3 ? Math.round(5e3 + Math.random() * 9e4) : 0;
    return { score: clamp(posts / 14 * 0.5 + (big ? 0.35 : 0) + 0.1), critical: '', flags: [], thought: `${posts} X posts${big ? `, biggest account ${fmtK(big)} followers` : ''}` };
  }

  async xSearch(t) {
    const sym = t.symbol.replace(/[^A-Za-z0-9_]/g, '');
    const parts = [`"${t.mint}"`];
    if (sym.length >= 2) parts.push(`"$${sym}"`);
    const query = `(${parts.join(' OR ')}) -is:retweet`;
    const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=25&tweet.fields=public_metrics&expansions=author_id&user.fields=public_metrics,username`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${this.cfg.xBearer}` }, signal: AbortSignal.timeout(8000) });
    if (r.status === 429) { this.xBlockedUntil = Date.now() + 15 * 60_000; this.log('X API rate limit hit, pausing X checks for 15 minutes'); return null; }
    if (!r.ok) { this.log('X API error', r.status); return null; }
    const j = await r.json();
    const tweets = j.data || [];
    const users = new Map((j.includes?.users || []).map((u) => [u.id, u]));
    const authors = new Set();
    let followers = 0, maxF = 0, maxU = '', eng = 0, hype = 0;
    for (const tw of tweets) {
      const u = users.get(tw.author_id);
      const f = u?.public_metrics?.followers_count || 0;
      if (!authors.has(tw.author_id)) { authors.add(tw.author_id); followers += f; }
      if (f > maxF) { maxF = f; maxU = u?.username || ''; }
      eng += (tw.public_metrics?.like_count || 0) + 2 * (tw.public_metrics?.retweet_count || 0);
      if (HYPE.test(tw.text || '')) hype++;
    }
    const flags = tweets.length >= 4 && hype > tweets.length / 2 ? ['most X posts are copy-paste hype'] : [];
    const score = clamp(Math.log10(1 + followers) / 6) * 0.45 + clamp(authors.size / 12) * 0.35 + clamp(Math.log10(1 + eng) / 3) * 0.2;
    return { score, critical: '', flags, thought: `${tweets.length} X posts from ${authors.size} accounts${maxF ? `, biggest @${maxU} (${fmtK(maxF)})` : ''}` };
  }

  async llmSearch(t) {
    this.llmCalls.push(Date.now());
    const prompt = `A Solana meme coin launched on pump.fun a few minutes ago.
Name: ${t.name}
Ticker: $${t.symbol}
Contract address: ${t.mint}
X link on its page: ${t.meta?.twitter || 'none'}

Search X (x.com) for posts about THIS coin: match the contract address, or the exact ticker together with pump.fun or Solana. Count the relevant posts you actually find, note accounts with large followings, and look for red flags (bot or copy-paste shilling, brand-new or reused accounts, scam warnings). Never guess numbers you did not see.
Reply with only JSON: {"posts_found": number, "notable_accounts": [{"handle": string, "followers": number}], "sentiment": "positive"|"neutral"|"negative", "red_flags": [string], "summary": string}`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.anthropicModel,
        max_tokens: 800,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) { this.log('Claude API error', r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let d;
    try { d = JSON.parse(m[0]); } catch { return null; }
    const posts = Math.max(0, +d.posts_found || 0);
    const notable = Array.isArray(d.notable_accounts) ? d.notable_accounts : [];
    const top = notable.reduce((a, b) => ((+b?.followers || 0) > (+a?.followers || 0) ? b : a), null);
    const maxF = +top?.followers || 0;
    const flags = (Array.isArray(d.red_flags) ? d.red_flags : []).map(String).slice(0, 3);
    const sent = d.sentiment === 'positive' ? 0.2 : d.sentiment === 'neutral' ? 0.1 : 0;
    const critical = flags.find((f) => /scam|rug|honeypot/i.test(f)) || '';
    return {
      score: clamp(clamp(posts / 10) * 0.4 + clamp(Math.log10(1 + maxF) / 6) * 0.4 + sent),
      critical,
      flags,
      thought: `${posts} X posts${maxF ? `, biggest @${top.handle} (${fmtK(maxF)})` : ''} · ${d.sentiment || 'neutral'}`,
    };
  }
}
