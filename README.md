# Trio Trader

A meme coin trading bot for **pump.fun** run by three agents, with a live dashboard.

| Agent | Watches | Votes BUY when |
|---|---|---|
| **Scout** | Every new pump.fun launch, live: buyers, money flowing in, speed, bonding-curve progress | Real buying momentum, not already crashing |
| **Hunter** | X and the coin's socials: posts, big accounts, reused X accounts, hype/shill patterns | Credible social buzz, no serial-launcher signs |
| **Professor** | On-chain risk (creator selling, whale wallets, launch snipers) plus a model that learns | Low risk and the model gives a high enough chance of profit |

**The rule:** the team buys only when all three say BUY. The Professor then manages the exit with take profit, stop loss, trailing stop, a time limit, and an emergency exit if the creator sells or sellers take over.

**How it learns:** besides its own trades, the bot "shadow trades" hundreds of coins it didn't buy. It follows each one as if it had bought it and records whether it would have made money after fees. Every result trains the Professor's model and re-tunes how strict each agent is. The dashboard shows the learning curve, each agent's accuracy, and which signals the bot has learned matter most.

**Practice money by default.** Trades are simulated at real pump.fun prices, with pump.fun fees, PumpPortal fees, a delay penalty and priority fees included. Real-money trading is built in but switched off (see the bottom of this guide).

### Self-improvement and safety (ideas adapted from [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading), MIT)
- **Self-tuning sell rule:** every learning coin is followed for 10 minutes and its price path is saved. Every 50 coins the bot replays 108 sell rules (take profit, stop loss, trailing stop, max hold) on older coins, then adopts the best one only if it also beats the current rule on the newest coins (walk-forward). Turn off with `AUTO_TUNE_EXITS=false`.
- **Signal health:** each of the 15 signals is graded *alive*, *reversed* or *dead* by its information coefficient across batches of coins, the same test Vibe-Trading uses for its alpha library.
- **Is it really working?** A bootstrap 95% range for the average trade result says whether profits are a real edge or could be luck. Plus profit factor, worst drop, losing streaks, and results by sell reason.
- **Market mood:** a hot/normal/cold state with two thresholds (hysteresis) from recent coin outcomes. In a cold market the Professor's bar rises by 10 points.
- **Circuit breaker:** no new buys for `COOLDOWN_MINUTES` (60) after `LOSS_STREAK_PAUSE` (5) losses in a row, or a `MAX_DRAWDOWN_PCT` (30%) drop from the best balance. The Resume button clears it.
- **WhatsApp alerts (optional):** buys, sells, circuit breaker, mood changes, tuned sell rules and a daily summary, through CallMeBot's free personal service. Setup: add **+34 694 25 79 52** to your phone contacts, send it **I allow callmebot to send me messages** on WhatsApp, and it replies with your API key. Then set `WHATSAPP_PHONE` (your number with country code, e.g. `+9665XXXXXXXX`) and `WHATSAPP_APIKEY`. Alerts are bundled and sent at most once every 20 seconds. Set `WHATSAPP_ALERTS=important` to get only the big moments (no individual trades).

---

## Put it on Railway (about 10 minutes)

### 1. Get the code onto GitHub
1. Create a free account at **github.com** if you don't have one.
2. Click **New repository**, name it `trio-trader`, keep it **Private**, and click **Create**.
3. On the new repo page, click **uploading an existing file**. Unzip `trio-trader.zip` on your computer and drag in **everything inside the folder** (`src`, `public`, `Dockerfile`, `railway.json`, `package.json`, `README.md`, …). Click **Commit changes**.

### 2. Deploy
1. Go to **railway.com**, sign in with GitHub, and pick the **Hobby** plan (about $5/month; the bot runs 24/7).
2. **New Project → Deploy from GitHub repo →** choose `trio-trader`. Railway sees the Dockerfile and builds it.

### 3. Give it a memory (important)
Without this, the bot forgets its trades and learning every time Railway restarts it.
1. In the project, right-click the service (or use **+ New**) → **Volume**, and attach it to the `trio-trader` service.
2. Set the **mount path** to `/data`.

### 4. Settings
In the service, open **Variables** and add:
- `DASHBOARD_PASSWORD` = a password you choose (enables the Pause / Close-all buttons)
- Optional, for a smarter Hunter, one of:
  - `X_BEARER_TOKEN` (X API, pay-per-use, about $0.05 per check, capped by `X_CHECKS_PER_HOUR`, default 6/hour), or
  - `ANTHROPIC_API_KEY` (Claude API key from console.anthropic.com; the Hunter asks Claude to search X for each coin the Scout likes, capped by `HUNTER_LLM_PER_HOUR`, default 4/hour, roughly $0.05 per check)

All other settings are listed in `.env.example`.

### 5. Open the dashboard
**Settings → Networking → Generate Domain**, then open the link on your phone or computer. You should see **pump.fun live** in green within a few seconds and the agents start talking.

To check what it's doing: **Deployments → View logs** shows every deal, exit and error.

---

## Or put it on Render (if Railway sign-ups are closed)
1. Go to **render.com** and sign up with GitHub.
2. **New → Blueprint**, pick the `trio-trader` repo, and tap **Apply**. Render reads `render.yaml` and sets up the always-on service plus a 1 GB disk for the bot's memory.
3. Type a `DASHBOARD_PASSWORD` when asked. Leave the two API keys empty if you don't have them.
4. When the deploy finishes, open the `onrender.com` link at the top of the service page.

Cost: the Starter plan is about $7/month plus about $0.25/month for the disk. Don't use the free plan: it sleeps after 15 minutes without visitors, and the bot would stop watching coins.

## Where the data comes from
- **New coins:** PumpPortal's free live feed.
- **Buys, sells and prices for each coin:** DexScreener's free API, checked every few seconds. This can't see individual wallets, so "creator sold" and "one wallet holds X%" checks only work with paid data.
- **Paid option (exact, wallet-level trades):** set `TRADE_DATA=pumpportal` and `PUMPPORTAL_API_KEY` with a PumpPortal wallet holding at least 0.02 SOL. PumpPortal charges 0.01 SOL per 10,000 trade messages, which can add up quickly when the bot watches hundreds of coins.

## How to judge it

- Leave it on practice money for **at least 2–4 weeks**. Early numbers swing a lot.
- Look at **Total profit**, **Win rate** and **Money over time**. A win rate can be high while the profit is still negative, because a few big losses outweigh many small wins.
- **Brain accuracy** above about 60% for a long stretch means it's finding a real pattern. Hovering around 50% means it isn't.
- Each agent's "Right X% of N calls" shows who is pulling their weight.

## Real money (only after a good practice record)

1. Create a Lightning wallet and API key at **pumpportal.fun**. Send it **only what you can afford to lose**.
2. Add these variables: `PUMPPORTAL_API_KEY`, `WALLET_PUBLIC_KEY` (shows the real balance), `LIVE_TRADING=true`.
3. Safety limits that apply in real mode: at most `MAX_LIVE_TRADE_SOL` per trade (default 0.25), `MAX_OPEN_POSITIONS`, a `DAILY_LOSS_LIMIT_SOL` that stops buying for the day, and trading stops automatically after 3 failed orders.
4. Real-mode fills are estimated from the bonding curve, so trust the wallet balance over the estimates.
5. Practice and real records are kept separately; the brain's learning carries over.

PumpPortal charges about 0.5% per trade on top of pump.fun's fees. The bot includes both in its practice results.

## Run it on your own computer (optional)
Needs Node.js 22+. In the folder run `npm start` (real pump.fun data, practice money) or `npm run sim` (fake coins for testing), then open http://localhost:3000.

## Honest warning
Most new pump.fun coins lose nearly all their value within hours, and many are deliberate rug pulls. Bots that sniped them profitably in the past often stop working as the market adapts. Nothing here is financial advice.
