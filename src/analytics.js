// Ideas adapted from HKUDS/Vibe-Trading (MIT): alpha "alive / reversed / dead" bench,
// bootstrap + walk-forward validation, trade metrics by exit reason, and regime hysteresis.
// Rewritten in plain JavaScript for pump.fun shadow trades.
import { FEATURE_NAMES } from './learner.js';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  if (x.length < 5) return null;
  const rx = ranks(x), ry = ranks(y);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/**
 * Signal health — Vibe-Trading's alpha bench, applied to our 15 signals.
 * Samples are split into chronological windows; in each window we measure the rank correlation (IC)
 * between a signal and the coin's result. alive: ic_mean > 0.02, ≥55% positive windows, |t| > 2.
 * reversed: ic_mean < −0.02 and |t| > 2 (the signal works backwards). dead: everything else.
 */
export function signalHealth(samples, windowSize = 40) {
  const S = samples.filter((s) => Array.isArray(s.x));
  const windows = Math.floor(S.length / windowSize);
  if (windows < 3) return { ready: false, need: windowSize * 3, have: S.length, signals: [] };
  const signals = FEATURE_NAMES.map((name, i) => {
    const ics = [];
    for (let w = 0; w < windows; w++) {
      const chunk = S.slice(w * windowSize, (w + 1) * windowSize);
      const ic = spearman(chunk.map((s) => s.x[i]), chunk.map((s) => s.ret));
      if (ic != null && Number.isFinite(ic)) ics.push(ic);
    }
    const m = mean(ics), sd = std(ics), n = ics.length;
    const t = sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
    const pos = n ? ics.filter((v) => v > 0).length / n : 0;
    const status = m > 0.02 && pos >= 0.55 && Math.abs(t) > 2 ? 'alive' : m < -0.02 && Math.abs(t) > 2 ? 'reversed' : 'dead';
    return { name, ic: +m.toFixed(3), t: +t.toFixed(2), positive: +pos.toFixed(2), status };
  });
  signals.sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic));
  return { ready: true, windows, have: S.length, signals };
}

/** 95% bootstrap range for the average return per trade: is the edge real, or luck? */
export function bootstrapEdge(rets, n = 1000) {
  if (rets.length < 10) return { ready: false, need: 10, have: rets.length };
  const means = [];
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let i = 0; i < rets.length; i++) s += rets[(Math.random() * rets.length) | 0];
    means.push(s / rets.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(n * 0.025)], hi = means[Math.floor(n * 0.975)];
  const verdict = lo > 0 ? 'proven' : hi < 0 ? 'losing' : 'unproven';
  return { ready: true, have: rets.length, mean: mean(rets), lo, hi, verdict };
}

/** Trade metrics in the style of Vibe-Trading's calc_metrics / by_exit_reason_stats. */
export function tradeMetrics(trades, equity, startBalance) {
  const T = [...trades].reverse(); // oldest first
  const gains = T.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const losses = -T.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  let streak = 0, worstStreak = 0;
  for (const t of T) { streak = t.pnl < 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); }
  let currentStreak = 0;
  for (const t of trades) { if (t.pnl < 0) currentStreak++; else break; }
  let peak = startBalance, maxDd = 0;
  for (const p of equity) { peak = Math.max(peak, p.v); maxDd = Math.max(maxDd, peak > 0 ? 1 - p.v / peak : 0); }
  const byReason = {};
  for (const t of T) {
    const r = (byReason[t.reason] ||= { reason: t.reason, count: 0, wins: 0, pnl: 0, retSum: 0 });
    r.count++; r.pnl += t.pnl; r.retSum += t.ret; if (t.pnl > 0) r.wins++;
  }
  return {
    trades: T.length,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : null,
    expectancySol: T.length ? (gains - losses) / T.length : null,
    avgRet: T.length ? mean(T.map((t) => t.ret)) : null,
    maxDrawdown: maxDd,
    worstStreak, currentStreak,
    byReason: Object.values(byReason).map((r) => ({ reason: r.reason, count: r.count, winRate: r.wins / r.count, avgRet: r.retSum / r.count, pnl: r.pnl }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Walk-forward check on the brain: is it right as often on recent coins as on older ones? */
export function walkForward(recent) {
  if (recent.length < 80) return { ready: false, need: 80, have: recent.length };
  const half = Math.floor(recent.length / 2);
  const acc = (arr) => arr.filter(([p, y]) => (p >= 0.5 ? 1 : 0) === y).length / arr.length;
  const older = acc(recent.slice(0, half)), newer = acc(recent.slice(half));
  const trend = newer - older > 0.03 ? 'improving' : older - newer > 0.05 ? 'slipping' : 'steady';
  return { ready: true, older, newer, trend };
}

// ---------- self-tuning sell rules ----------
/** Replay one recorded price path ([seconds, return] points) under a sell rule. */
export function replay(path, rule) {
  let peak = 0, last = 0;
  for (const [sec, ret] of path) {
    last = ret;
    peak = Math.max(peak, ret);
    if (ret >= rule.takeProfit) return rule.takeProfit; // assume the target fills
    if (ret <= -rule.stopLoss) return ret;
    if (peak >= 0.15 && peak - ret >= rule.trailing) return ret;
    if (sec >= rule.maxHoldMin * 60) return ret;
  }
  return last;
}

/** Sell rules to try. The stop loss stays fixed (yours); take profit never goes above maxTakeProfit. */
export function exitGrid(stopLoss, maxTakeProfit) {
  const out = [];
  for (const takeProfit of [0.15, 0.2, 0.25, 0.3, 0.4, 0.5].filter((v) => v <= maxTakeProfit + 1e-9))
    for (const trailing of [0.08, 0.12, 0.2])
      for (const maxHoldMin of [3, 6, 10]) out.push({ takeProfit, stopLoss, trailing, maxHoldMin });
  return out;
}

/**
 * Pick the sell rule that made the most on older paths, then keep it only if it also beats the
 * current rule on the newest third (walk-forward). Returns null if nothing clearly better.
 */
export function optimizeExits(paths, current, maxTakeProfit = 0.4) {
  if (paths.length < 90) return null;
  const cut = Math.floor(paths.length * 2 / 3);
  const train = paths.slice(0, cut), test = paths.slice(cut);
  const score = (set, rule) => mean(set.map((p) => replay(p, rule)));
  let best = null;
  for (const rule of exitGrid(current.stopLoss, maxTakeProfit)) {
    const s = score(train, rule);
    if (!best || s > best.train) best = { rule, train: s };
  }
  const bestTest = score(test, best.rule), curTest = score(test, current);
  const accepted = bestTest > curTest + 0.005;
  return { accepted, rule: best.rule, trainAvg: best.train, testAvg: bestTest, currentTestAvg: curTest, paths: paths.length };
}

/** Market mood with hysteresis (two thresholds), like Vibe-Trading's regime detector. */
export function nextMood(prev, winRate) {
  if (winRate == null) return prev || 'normal';
  if (prev === 'hot') return winRate < 0.3 ? 'normal' : 'hot';
  if (prev === 'cold') return winRate > 0.27 ? 'normal' : 'cold';
  if (winRate >= 0.38) return 'hot';
  if (winRate <= 0.2) return 'cold';
  return 'normal';
}
