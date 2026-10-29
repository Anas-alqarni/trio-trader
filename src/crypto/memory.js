// Memory and reflection, adapted from TradingAgents (TauricResearch, Apache-2.0) without the paid AI calls:
//  • Recall: before a trade, find the most similar past setups and see how they turned out (k nearest neighbours).
//  • Coin record: past results for the same coin and side; a coin+side that keeps losing gets a rest.
//  • Lessons: every closed trade writes a one-line reflection of what happened and whether memory was right.

const K = 25;
export const MEMORY_READY = 200; // samples needed before memory gets a say

/** Find the K most similar past setups. norm = the brain's own standardizer, so every signal counts equally. */
export function recall(samples, x, norm, version = 0) {
  if (samples.length < MEMORY_READY) return null;
  const q = norm(x);
  const best = []; // [dist, sample], kept sorted, at most K
  for (const s of samples) {
    // Standardized copy cached on the sample, hidden from saving, refreshed when the standardizer moves on.
    if (s._zv !== version) { Object.defineProperty(s, '_z', { value: norm(s.x), writable: true, configurable: true }); Object.defineProperty(s, '_zv', { value: version, writable: true, configurable: true }); }
    const v = s._z;
    let d = 0;
    for (let i = 0; i < q.length; i++) { const t = q[i] - v[i]; d += t * t; if (best.length === K && d >= best[K - 1][0]) break; }
    if (best.length === K && d >= best[K - 1][0]) continue;
    best.push([d, s]); best.sort((a, b) => a[0] - b[0]); if (best.length > K) best.pop();
  }
  const n = best.length;
  const L = best.map(([, s]) => s.ret), S = best.filter(([, s]) => s.sret != null).map(([, s]) => s.sret);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    n,
    longWin: L.filter((r) => r > 0).length / n, longAvg: mean(L),
    shortWin: S.length ? S.filter((r) => r > 0).length / S.length : null, shortAvg: mean(S), shortN: S.length,
  };
}

export function memoryLine(m, side) {
  if (!m) return '';
  const win = side === 'short' ? m.shortWin : m.longWin, n = side === 'short' ? m.shortN : m.n;
  if (win == null || !n) return '';
  return `Memory: ${Math.round(win * n)} of ${n} similar setups won`;
}

/** Per coin and side: trades, wins, money, current losing streak, and a rest after repeated losses. */
export function recordTrade(records, key, pnl, restAfter, restMs) {
  const r = (records[key] ||= { n: 0, wins: 0, pnl: 0, streak: 0, restUntil: 0 });
  r.n++; r.pnl += pnl;
  if (pnl > 0) { r.wins++; r.streak = 0; } else r.streak++;
  let rested = false;
  if (restAfter > 0 && r.streak >= restAfter) { r.restUntil = Date.now() + restMs; r.streak = 0; rested = true; }
  return { r, rested };
}

/** A short reflection on a finished trade, in plain words. */
export function reflect({ symbol, side, ret, reason, btcMove, memWin, rec, rested, restHours }) {
  const won = ret > 0, dir = side === 'short' ? -1 : 1;
  const bits = [`${won ? 'Won' : 'Lost'} ${side === 'short' ? 'short' : 'buy'} on ${symbol} (${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(1)}%, ${reason})`];
  if (btcMove != null && Math.abs(btcMove) >= 0.002) bits.push(`Bitcoin moved ${btcMove * dir > 0 ? 'with' : 'against'} it (${btcMove >= 0 ? '+' : ''}${(btcMove * 100).toFixed(1)}%)`);
  if (memWin != null) bits.push(`memory said ${Math.round(memWin * 100)}% of similar setups win, ${(memWin >= 0.5) === won ? 'and it was right' : 'and it was wrong this time'}`);
  if (rec) bits.push(`${symbol} ${side === 'short' ? 'shorts' : 'buys'} so far: ${rec.wins} of ${rec.n} won`);
  if (rested) bits.push(`too many losses in a row, resting ${symbol} ${side === 'short' ? 'shorts' : 'buys'} for ${restHours}h`);
  return bits.join('. ') + '.';
}

/** The risk team: three voices judge the whole portfolio, not just this coin. Returns the size multiplier (0 = reject). */
export function riskTeam({ side, positions, dailyPnl, dailyLimit, lastTrades, mood, atr, maxAtr, maxSameSide }) {
  const same = positions.filter((p) => (p.side || 'long') === side).length;
  const used = dailyLimit > 0 ? -dailyPnl / dailyLimit : 0;
  const lostLast2 = lastTrades.length >= 2 && lastTrades[0].pnl < 0 && lastTrades[1].pnl < 0;
  const v = {
    aggressive: used >= 0.8 ? ['no', 'nearly at the daily loss limit'] : ['ok', 'go for it'],
    neutral: same >= maxSameSide ? ['no', `already ${same} ${side === 'short' ? 'shorts' : 'buys'}, they all move with Bitcoin`] : same >= maxSameSide - 1 ? ['smaller', `${same} trades already lean the same way`] : ['ok', 'portfolio is balanced'],
    conservative: used >= 0.5 ? ['no', 'already lost half the daily limit'] : lostLast2 ? ['smaller', 'last 2 trades lost'] : mood === 'cold' ? ['smaller', 'market mood is cold'] : atr > maxAtr * 0.6 ? ['smaller', 'coin is jumpy'] : ['ok', 'risk looks fine'],
  };
  const votes = Object.values(v).map((x) => x[0]);
  const no = votes.filter((x) => x === 'no').length, smaller = votes.filter((x) => x === 'smaller').length;
  // Too many trades leaning the same way is a hard stop: they all follow Bitcoin, so it is really one big bet.
  const mult = no >= 2 || v.neutral[0] === 'no' ? 0 : no === 1 || smaller >= 2 ? 0.6 : 1;
  const verdict = mult === 0 ? 'rejected' : mult < 1 ? 'smaller size' : 'full size';
  const worry = Object.entries(v).find(([, x]) => x[0] !== 'ok');
  return { mult, verdict, votes: v, text: `Risk team: ${verdict}${worry ? ` (${worry[0]}: ${worry[1][1]})` : ''}` };
}
