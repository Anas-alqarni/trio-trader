export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const sgnlog = (v) => Math.sign(v) * Math.log1p(Math.abs(v));
export const fmtAge = (s) => (s < 90 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)}m`);
export const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Small concurrency limiter so we never flood a remote API. */
export function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
  };
  const run = (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
  run.pending = () => queue.length;
  return run;
}
