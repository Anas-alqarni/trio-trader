import fs from 'node:fs';
import path from 'node:path';

/** Tiny JSON file store with atomic, debounced writes (survives restarts on a Railway volume). */
export function createStore(dir, name, defaults) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  let state = structuredClone(defaults);
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  let timer = null;
  const saveNow = () => {
    clearTimeout(timer); timer = null;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  };
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => { try { saveNow(); } catch (e) { console.error('save failed', e.message); } }, 5000);
  };
  return { get state() { return state; }, save, saveNow, file };
}
