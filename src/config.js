// All settings come from environment variables (set them in Railway → Variables).
const env = process.env;
const num = (k, d) => { const v = env[k]; if (v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const bool = (k, d) => { const v = env[k]; if (v === undefined || v === '') return d; return /^(1|true|yes|on)$/i.test(v); };

const simulate = bool('SIMULATE', false);
const live = !simulate && bool('LIVE_TRADING', false);

const market = (env.MARKET || 'crypto').toLowerCase(); // 'crypto' (major coins) or 'meme' (pump.fun)

const cfg = {
  market,
  crypto: {
    simulate,
    candleSec: num('CANDLE_SECONDS', simulate ? 3 : 300),
    pollSec: num('CRYPTO_POLL_SECONDS', simulate ? 1 : 30),
    coins: env.CRYPTO_COINS ? env.CRYPTO_COINS.split(',').map((s) => s.trim().toUpperCase()).map((s) => (s.includes('-') ? s : s + '-USD')) : null,
    startBalance: num('START_BALANCE_USD', 100),
    tradeSize: num('TRADE_SIZE_USD', 15),
    maxOpen: num('CRYPTO_MAX_OPEN', 5),
    dailyLossLimit: num('DAILY_LOSS_LIMIT_USD', 8),
    fee: num('CRYPTO_FEE_PCT', 0.1) / 100,          // per side; 0.1% is typical on Binance/OKX/Bybit
    slippage: num('CRYPTO_SLIPPAGE_PCT', 0.05) / 100,
    takeProfit: num('CRYPTO_TAKE_PROFIT_PCT', 2) / 100,
    stopLoss: num('CRYPTO_STOP_LOSS_PCT', 1.5) / 100, // never changed by the tuner
    trailing: num('CRYPTO_TRAILING_PCT', 0.8) / 100,
    trailStart: num('CRYPTO_TRAIL_START_PCT', 0.6) / 100,
    maxHoldMin: num('CRYPTO_MAX_HOLD_MINUTES', 360),
    maxTakeProfit: num('CRYPTO_MAX_TAKE_PROFIT_PCT', 4) / 100,
    maxAtr: num('CRYPTO_MAX_ATR_PCT', 1.2) / 100,
    guardian: bool('CRYPTO_GUARDIAN', true),               // 4th agent: sizes trades, can close a trade early
    guardMinMult: num('GUARDIAN_MIN_SIZE', 0.5), guardMaxMult: num('GUARDIAN_MAX_SIZE', 1.5),
    shorts: bool('CRYPTO_SHORTS', true),                    // practice shorts: profit when a coin falls
    // Ideas from TradingAgents (TauricResearch): bull vs bear debate, a risk team, memory of similar setups.
    debateMargin: num('DEBATE_MARGIN_PCT', 5) / 100,       // the winning side must beat the other side's chance by this much
    memoryWeight: num('MEMORY_WEIGHT', 0.3),              // how much similar past setups count in the Professor's chance
    coinRestAfter: num('COIN_REST_AFTER_LOSSES', 3),      // a coin+side that loses this many times in a row rests…
    coinRestHours: num('COIN_REST_HOURS', 6),             // …for this many hours
    riskTeam: bool('CRYPTO_RISK_TEAM', true),
    maxSameSide: num('MAX_SAME_SIDE', 3),                 // most trades leaning the same way (they all follow Bitcoin)
    leverage: Math.max(1, Math.min(20, num('CRYPTO_LEVERAGE', 10))), // practice leverage: a 2% move = 20% on the trade's money at 10x
    fundingPer8h: num('CRYPTO_FUNDING_PCT_8H', 0.01) / 100, // what a short pays to stay open, per 8 hours
    // Super deals: when every slot is full, a coin far above the bars can still get in.
    superSlots: num('CRYPTO_SUPER_SLOTS', 1),
    superMinProb: num('CRYPTO_SUPER_MIN_PROB', 65) / 100,  // Professor's chance of profit at least this…
    superMargin: num('CRYPTO_SUPER_MARGIN', 15) / 100,     // …and this far above his normal bar
    superMinScout: num('CRYPTO_SUPER_MIN_SCOUT', 0.75),    // and a very strong chart
    maxBars: { scout: num('CRYPTO_MAX_SCOUT_BAR', 0.55), hunter: num('CRYPTO_MAX_HUNTER_BAR', 0.5), professor: num('CRYPTO_MAX_PROFESSOR_BAR', 0.5) },
  },
  port: num('PORT', 3000),
  dataDir: env.DATA_DIR || './data',
  simulate,
  live,
  mode: simulate ? 'sim' : market === 'crypto' ? 'paper' : live ? 'live' : 'paper',

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

  // Telegram alerts (recommended): only the bot token is needed; send /start to your bot
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: env.TELEGRAM_CHAT_ID || '',
  alertLevel: (env.ALERTS || env.WHATSAPP_ALERTS || 'all').toLowerCase(), // 'all' or 'important'
  // WhatsApp alerts via CallMeBot (optional, used only if Telegram isn't set)
  whatsappPhone: env.WHATSAPP_PHONE || '',
  whatsappKey: env.WHATSAPP_APIKEY || '',
  whatsappLevel: (env.WHATSAPP_ALERTS || 'all').toLowerCase(), // 'all' or 'important'

  simSpawnMs: num('SIM_SPAWN_MS', 2500),
};

if (cfg.live) cfg.tradeSizeSol = Math.min(cfg.tradeSizeSol, num('MAX_LIVE_TRADE_SOL', 0.25));
cfg.feePct = cfg.pumpFeePct + cfg.lightningFeePct;

export default cfg;
