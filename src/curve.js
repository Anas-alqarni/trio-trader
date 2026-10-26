// pump.fun bonding curve (constant product on virtual reserves).
export const TOTAL_SUPPLY = 1e9;            // tokens (human units)
export const INIT_VSOL = 30;                // virtual SOL at launch
export const INIT_VTOK = 1_073_000_000;     // virtual tokens at launch
export const COMPLETE_VSOL = 115;           // ~85 real SOL raised → migrates

export const buyQuote = (vSol, vTok, solIn, feePct) => {
  const s = solIn * (1 - feePct);
  return vTok - (vSol * vTok) / (vSol + s);
};
export const sellQuote = (vSol, vTok, tokIn, feePct) => {
  const out = vSol - (vSol * vTok) / (vTok + tokIn);
  return out * (1 - feePct);
};
export const progress = (vSol) => Math.max(0, Math.min(1, (vSol - INIT_VSOL) / (COMPLETE_VSOL - INIT_VSOL)));
