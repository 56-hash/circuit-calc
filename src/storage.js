// IndexedDB: 기록(세션) 저장. 이미지와 기록은 이 기기 안에만 보관한다.
const DB_NAME = 'circuit-calc';
const STORE = 'sessions';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const st = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      st.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export const saveSession = (rec) => tx('readwrite', (st) => wrap(st.add({ ...rec, createdAt: rec.createdAt ?? Date.now() })));
export const updateSession = (id, patch) => tx('readwrite', async (st) => {
  const cur = await wrap(st.get(id));
  if (!cur) return null;
  await wrap(st.put({ ...cur, ...patch, id }));
  return id;
});
export const getSession = (id) => tx('readonly', (st) => wrap(st.get(id)));
export const deleteSession = (id) => tx('readwrite', (st) => wrap(st.delete(id)));
export const listSessions = () => tx('readonly', (st) => wrap(st.getAll())).then((all) => all.sort((a, b) => b.createdAt - a.createdAt));
export async function purgeOlderThan(days) {
  const cutoff = Date.now() - days * 86400000;
  const all = await listSessions();
  const old = all.filter((s) => s.createdAt < cutoff);
  for (const s of old) await deleteSession(s.id);
  return old.length;
}
export const clearAll = () => tx('readwrite', (st) => wrap(st.clear()));
