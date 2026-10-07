// Browser shims so the app's ES modules can run under Node.
import 'fake-indexeddb/auto';
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
