import { clamp, fmtAge } from '../util.js';

/**
 * SCOUT — watches pump.fun itself: who is buying, how fast, and whether the money keeps coming.
 * Returns a 0..1 momentum score, a deal-breaker (critical) if any, and a one-line thought.
 */
export function scout(f) {
  let critical = '';
  if (f.drawdown < -0.45) critical = `price already fell ${Math.round(-f.drawdown * 100)}% from its peak`;
  else if (f.sells > 8 && f.ratio < 0.7) critical = 'more sellers than buyers';

  let s = 0;
  s += clamp((f.buyers - 4) / 36) * 0.30;
  s += clamp((f.ratio - 1) / 3) * 0.20;
  s += clamp(f.buyVel / 6) * 0.20;
  s += clamp((f.accel + 1) / 4) * 0.10;
  s += f.progress > 0.05 && f.progress < 0.8 ? 0.10 : 0;
  s += f.drawdown > -0.2 ? 0.10 : 0;

  const thought = critical
    ? `Pass: ${critical}`
    : `${f.buyers} buyers in ${fmtAge(f.age)} · ${f.buyVel.toFixed(1)} SOL bought in 30s · curve ${Math.round(f.progress * 100)}% full`;
  return { score: clamp(s), critical, thought };
}
