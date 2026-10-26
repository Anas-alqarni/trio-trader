import { clamp } from '../util.js';

/**
 * PROFESSOR — reads the on-chain picture (who holds what, did the creator sell, snipers),
 * asks the learned model for a win probability, and makes the final call.
 */
export function professor(f, scoutRes, hunterRes, learner, x) {
  const risks = [];
  if (f.creatorSold) risks.push('the creator already sold');
  if (f.topHolderPct > 0.09) risks.push(`one wallet holds ${(f.topHolderPct * 100).toFixed(0)}% of supply`);
  if (f.creatorPct > 0.12) risks.push(`creator still holds ${(f.creatorPct * 100).toFixed(0)}%`);
  if (f.sniperPct > 0.2) risks.push(`snipers grabbed ${(f.sniperPct * 100).toFixed(0)}% at launch`);

  const heuristic = clamp(0.1 + 0.5 * scoutRes.score + 0.3 * hunterRes.score + (f.drawdown > -0.15 ? 0.1 : 0));
  const p = learner.predict(x, heuristic);
  const learning = learner.n < 150 ? ' (still learning)' : '';
  return {
    score: p,
    critical: risks[0] || '',
    risks,
    thought: risks.length ? `Too risky: ${risks[0]}` : `${Math.round(p * 100)}% chance of profit${learning}`,
  };
}

/** The Professor's exit rules, used for real positions and for the shadow trades the bot learns from. */
export function exitReason({ ret, peakRet, heldSec, creatorSoldNow, flow30 }, cfg) {
  if (ret >= cfg.takeProfit) return 'take profit';
  if (ret <= -cfg.stopLoss) return 'stop loss';
  if (peakRet >= 0.15 && peakRet - ret >= cfg.trailing) return 'trailing stop';
  if (creatorSoldNow) return 'creator sold';
  if (flow30 < -1.5 && ret < 0) return 'sellers took over';
  if (heldSec >= cfg.maxHoldMin * 60) return 'time limit';
  return null;
}
