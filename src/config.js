// All settings come from environment variables (set them in Railway → Variables).
const env = process.env;
const num = (k, d) => { const v = env[k]; if (v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const bool = (k, d) => { const v = env[k]; if (v === undefined || v === '') return d; return /^(1|true|yes|on)$/i.test(v); };

const simulate = bool('SIMULATE', false);
const live = !simulate && bool('LIVE_TRADING', false);

const cfg = {
  port: num('PORT', 3000),
  dataDir: env.DATA_DIR || './data',
  simulate,
  live,
  mode: simulate ? 'sim' : live ? 'live' : 'paper',

  // Live trading (off by default) — PumpPortal "Lightning" trade API
  pumpPortalKey: env.PUMPPORTAL_API_KEY || '',
  feedUrl: env.PUMPPORTAL_WS_URL || '',
  // 'dexscreener' (free, default) or 'pumpportal' (paid per message, needs PUMPPORTAL_API_KEY)
  tradeData: (env.TRADE_DATA || 'dexscreener').toLowerCase(),
  walletPublicKey: env.WALLET_PUBLIC_KEY || '',
  solanaRpc: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Hunter's view of X
  xBearer: env.X_BEARER_TOKEN || '',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  hunterLlmPerHour: num('HUNTER_LLM_PER_HOUR', 4),
  xChecksPerHour: num('X_CHECKS_PER_HOUR', 6),

  password: env.DASHBOARD_PASSWORD || '',

  // Money management
  startBalanceSol: num('START_BALANCE_SOL', 1),
  tradeSizeSol: num('TRADE_SIZE_SOL', 0.05),
  maxOpen: num('MAX_OPEN_POSITIONS', 3),
  takeProfit: num('TAKE_PROFIT_PCT', 60) / 100,
  stopLoss: num('STOP_LOSS_PCT', 25) / 100,
  trailing: num('TRAILING_STOP_PCT', 20) / 100,
  maxHoldMin: num('MAX_HOLD_MINUTES', 15),
  dailyLossLimitSol: num('DAILY_LOSS_LIMIT_SOL', 0.25),

  // Costs used to make paper results realistic
  pumpFeePct: num('PUMP_FEE_PCT', 1.25) / 100,
  lightningFeePct: num('PUMPPORTAL_FEE_PCT', 0.5) / 100,
  latencyPenaltyPct: num('LATENCY_PENALTY_PCT', 2) / 100,
  slippagePct: num('SLIPPAGE_PCT', 15),
  priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0005),

  // How the team watches coins
  watchMinutes: num('WATCH_MINUTES', 6),
  checkpoints: (env.CHECKPOINTS || '20,45,90,150,240').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b),
  maxTracked: num('MAX_TRACKED', 450),
  maxShadows: num('MAX_SHADOWS', 220),

  // Self-improvement and safety
  autoTuneExits: bool('AUTO_TUNE_EXITS', true),
  maxTakeProfit: num('MAX_TAKE_PROFIT_PCT', 40) / 100,  // the tuner never aims higher than this
  // How strict the team may get. Bars can never go above these, and a coin in the top TOP_PERCENT
  // of everything the agents saw recently always passes that agent, so the team keeps trading.
  maxBars: { scout: num('MAX_SCOUT_BAR', 0.5), hunter: num('MAX_HUNTER_BAR', 0.3), professor: num('MAX_PROFESSOR_BAR', 0.45) },
  topPercent: num('TOP_PERCENT', 12) / 100,
  coldMarketStricter: bool('COLD_MARKET_STRICTER', false),
  shadowHorizonSec: num('SHADOW_HORIZON_SEC', 600), // follow each learning coin 10 min (the longest hold the tuner tries)
  lossStreakPause: num('LOSS_STREAK_PAUSE', 5),
  maxDrawdownPct: num('MAX_DRAWDOWN_PCT', 30) / 100,
  cooldownMin: num('COOLDOWN_MINUTES', 60),

  // WhatsApp alerts via CallMeBot (optional)
  whatsappPhone: env.WHATSAPP_PHONE || '',
  whatsappKey: env.WHATSAPP_APIKEY || '',
  whatsappLevel: (env.WHATSAPP_ALERTS || 'all').toLowerCase(), // 'all' or 'important'

  simSpawnMs: num('SIM_SPAWN_MS', 2500),
};

if (cfg.live) cfg.tradeSizeSol = Math.min(cfg.tradeSizeSol, num('MAX_LIVE_TRADE_SOL', 0.25));
cfg.feePct = cfg.pumpFeePct + cfg.lightningFeePct;

export default cfg;
