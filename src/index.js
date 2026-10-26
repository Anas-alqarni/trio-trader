import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cfg from './config.js';
import { log, limiter } from './util.js';
import { createStore } from './store.js';
import { PumpPortalFeed } from './feed/pumpportal.js';
import { SimFeed } from './feed/simulator.js';
import { Market } from './market.js';
import { Hunter } from './agents/hunter.js';
import { PaperBroker } from './broker/paper.js';
import { LiveBroker } from './broker/live.js';
import { Engine, ledgerDefaults, brainDefaults } from './engine.js';
import { startServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- SOL price (for showing dollars) ----
const sol = { usd: cfg.simulate ? 160 : 150 };
async function refreshSol() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j?.solana?.usd) sol.usd = j.solana.usd;
  } catch { /* keep last value */ }
}

// ---- coin metadata (X / Telegram / website links) ----
const metaLimit = limiter(6);
async function fetchMeta(t) {
  if (cfg.simulate) return feed.getMeta(t.mint);
  if (!/^https?:\/\//.test(t.uri) || metaLimit.pending() > 150) return null;
  return metaLimit(async () => {
    const r = await fetch(t.uri, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      description: String(j.description || '').slice(0, 300),
      twitter: String(j.twitter || j.extensions?.twitter || ''),
      telegram: String(j.telegram || j.extensions?.telegram || ''),
      website: String(j.website || j.extensions?.website || ''),
    };
  });
}

// ---- price after a coin leaves the bonding curve ----
async function dexPrice(mint) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6000) });
  const j = await r.json();
  const pair = (j.pairs || []).filter((p) => p.quoteToken?.symbol === 'SOL').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return pair ? +pair.priceNative : null;
}

const feed = cfg.simulate ? new SimFeed(cfg) : new PumpPortalFeed(log);
const ledger = createStore(cfg.dataDir, `ledger-${cfg.mode}.json`, ledgerDefaults(cfg));
const brain = createStore(cfg.dataDir, `brain-${cfg.simulate ? 'sim' : 'real'}.json`, brainDefaults());
const broker = cfg.live ? new LiveBroker(cfg, log) : new PaperBroker();
const hunter = new Hunter(cfg, log);
const engine = new Engine({ cfg, feed, market: new Market(), hunter, broker, ledger, brain, sol, log, fetchMeta, dexPrice: cfg.simulate ? null : dexPrice });

log(`Trio Trader starting in ${cfg.mode.toUpperCase()} mode`);
log(`Hunter reads X using: ${hunter.source}`);
if (cfg.live && !cfg.pumpPortalKey) log('LIVE_TRADING is on but PUMPPORTAL_API_KEY is missing: no trades will be placed.');
if (cfg.live) log(`REAL MONEY: ${cfg.tradeSizeSol} SOL per trade, max ${cfg.maxOpen} open, daily loss limit ${cfg.dailyLossLimitSol} SOL`);
if (!cfg.password) log('Tip: set DASHBOARD_PASSWORD to enable the pause / close buttons.');

engine.start();
feed.start();
if (!cfg.simulate) { refreshSol(); setInterval(refreshSol, 5 * 60_000); }
startServer({ cfg, engine, log, htmlPath: path.join(here, '..', 'public', 'index.html') });

const shutdown = () => {
  log('saving and shutting down');
  try { engine.persist(); ledger.saveNow(); brain.saveNow(); } catch (e) { log('save failed', e.message); }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => log('unhandled', e?.message || e));
