/* 端末内の保管庫。サーバーは使わないので、ここが唯一の保存先になる。

   画像は Blob のまま入れる。base64 にすると容量が 1.33 倍になり、
   端末の割り当てを無駄に食うため。 */

const DB_NAME = 'memocard';
const DB_VERSION = 1;

let _db = null;

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;

      if (!db.objectStoreNames.contains('folders')) {
        const s = db.createObjectStore('folders', { keyPath: 'id' });
        s.createIndex('parentId', 'parentId');
      }

      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('folderId', 'folderId');
        // 「今日ぶんの復習」を引くのに使う。期限の昇順で走査できる
        s.createIndex('due', 'srs.due');
      }

      if (!db.objectStoreNames.contains('links')) {
        const s = db.createObjectStore('links', { keyPath: 'id' });
        // 無向なので、どちら側からも引けるように両方に索引を張る
        s.createIndex('aId', 'aId');
        s.createIndex('bId', 'bId');
      }

      if (!db.objectStoreNames.contains('maps')) {
        db.createObjectStore('maps', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then(db => db.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const get    = (store, id)    => tx(store, 'readonly').then(s => wrap(s.get(id)));
export const all    = (store)        => tx(store, 'readonly').then(s => wrap(s.getAll()));
export const put    = (store, value) => tx(store, 'readwrite').then(s => wrap(s.put(value)));
export const remove = (store, id)    => tx(store, 'readwrite').then(s => wrap(s.delete(id)));

export const byIndex = (store, index, value) =>
  tx(store, 'readonly').then(s => wrap(s.index(index).getAll(value)));

/** 期限が upTo 以前のカードを、期限の早い順に返す */
export function due(upTo) {
  return tx('cards', 'readonly').then(s =>
    wrap(s.index('due').getAll(IDBKeyRange.upperBound(upTo)))
  );
}

/** 複数件をひとつのトランザクションで書く。復習で連鎖更新するときに使う */
export function putMany(store, values) {
  if (!values.length) return Promise.resolve();
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    values.forEach(v => s.put(v));
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  }));
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
