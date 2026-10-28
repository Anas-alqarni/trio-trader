// The crypto team. Same three agents, new jobs:
//   Scout     — the coin's own chart: trend, momentum, breakout, volume, RSI.
//   Hunter    — the whole market's mood: Fear & Greed index, Bitcoin's trend, strength versus Bitcoin.
//   Professor — risk (volatility, overheating) plus the learned model; makes the final call.
import { clamp } from '../util.js';

export const CRYPTO_FEATURES = [
  'Last 5 minutes', 'Last 30 minutes', 'Last 2 hours', 'Last 24 hours', 'Short vs long trend (EMA)',
  'Breakout of 2h high', 'Volume vs normal', 'RSI', 'Volatility (ATR)', 'Bitcoin last 2 hours',
  'Strength vs Bitcoin', 'Fear & Greed',
];

const ema = (vals, n) => { const k = 2 / (n + 1); let e = vals[0]; for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; };
function rsi(closes, n = 14) {
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atrPct(cs, n = 14) {
  let s = 0;
  for (let i = cs.length - n; i < cs.length; i++) s += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  return s / n / cs[cs.length - 1].c;
}
const ret = (cs, k) => cs[cs.length - 1].c / cs[Math.max(0, cs.length - 1 - k)].c - 1;

/** Features from closed candles only (oldest-first). btc = Bitcoin's closed candles. */
export function cryptoFeatures(cs, btc, fg) {
  const closes = cs.map((x) => x.c);
  const last = cs[cs.length - 1];
  const prevHigh = Math.max(...cs.slice(-25, -1).map((x) => x.h));
  const avgVol = cs.slice(-21, -1).reduce((a, x) => a + x.v, 0) / 20;
  const f = {
    price: last.c,
    r1: ret(cs, 1), r6: ret(cs, 6), r24: ret(cs, 24), r288: ret(cs, Math.min(288, cs.length - 1)),
    emaGap: ema(closes.slice(-60), 20) / ema(closes.slice(-120), 50) - 1,
    breakout: last.c / prevHigh - 1,
    volRatio: avgVol > 0 ? last.v / avgVol : 1,
    rsi: rsi(closes),
    atr: atrPct(cs),
    btc24: btc ? ret(btc, 24) : 0,
    btcTrend: btc ? ema(btc.map((x) => x.c).slice(-60), 20) / ema(btc.map((x) => x.c).slice(-120), 50) - 1 : 0,
    fg: fg?.value ?? 50,
  };
  f.relStrength = f.r24 - f.btc24;
  return f;
}

export function cryptoVector(f) {
  return [f.r1 * 100, f.r6 * 100, f.r24 * 100, f.r288 * 100, f.emaGap * 100, f.breakout * 100, Math.log(Math.max(0.05, f.volRatio)), (f.rsi - 50) / 10, f.atr * 100, f.btc24 * 100, f.relStrength * 100, (f.fg - 50) / 25];
}

const pct = (v, d = 1) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

export function cryptoScout(f) {
  let critical = '';
  if (f.rsi > 80) critical = `overheated (RSI ${f.rsi.toFixed(0)})`;
  else if (f.r6 < -0.025) critical = `falling fast (${pct(f.r6)} in 30 min)`;
  let s = 0;
  s += f.emaGap > 0 ? 0.3 : 0;
  s += clamp(f.r6 / 0.01) * 0.2;
  s += f.breakout > 0 ? 0.2 : f.breakout > -0.003 ? 0.1 : 0;
  s += clamp((f.volRatio - 1) / 1.5) * 0.15;
  s += f.rsi >= 50 && f.rsi <= 70 ? 0.15 : 0;
  const thought = critical ? `Pass: ${critical}` : `${f.emaGap > 0 ? 'Trend up' : 'Trend down'} · ${pct(f.r6)} in 30m · volume ${f.volRatio.toFixed(1)}x · RSI ${f.rsi.toFixed(0)}`;
  return { score: clamp(s), critical, thought };
}

export function cryptoHunter(f, isBtc) {
  let critical = '';
  if (f.btc24 < -0.03) critical = `Bitcoin is dropping hard (${pct(f.btc24)} in 2h)`;
  const fgLabel = f.fg < 25 ? 'extreme fear' : f.fg < 45 ? 'fear' : f.fg <= 55 ? 'neutral' : f.fg < 75 ? 'greed' : 'extreme greed';
  let s = 0;
  s += clamp((f.fg - 20) / 60) * 0.3;
  s += f.btcTrend > 0 ? 0.35 : 0.07;
  s += isBtc ? 0.15 : clamp(0.5 + f.relStrength / 0.02) * 0.35;
  const thought = critical ? `Pass: ${critical}` : `Fear & Greed ${Math.round(f.fg)} (${fgLabel}) · Bitcoin trend ${f.btcTrend > 0 ? 'up' : 'down'}${isBtc ? '' : ` · ${f.relStrength >= 0 ? 'stronger' : 'weaker'} than BTC by ${pct(Math.abs(f.relStrength))}`}`;
  return { score: clamp(s), critical, thought };
}

export function cryptoProfessor(f, s, h, learner, x, maxAtr) {
  const risks = [];
  if (f.atr > maxAtr) risks.push(`too jumpy right now (moves ${(f.atr * 100).toFixed(1)}% per candle)`);
  if (f.r288 > 0.15) risks.push(`already up ${pct(f.r288, 0)} today`);
  const heuristic = clamp(0.15 + 0.45 * s.score + 0.3 * h.score);
  const p = learner.predict(x, heuristic);
  return { score: p, critical: risks[0] || '', thought: risks.length ? `Too risky: ${risks[0]}` : `${Math.round(p * 100)}% chance of profit${learner.n < 150 ? ' (still learning)' : ''}` };
}
