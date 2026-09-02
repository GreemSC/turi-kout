// Acces IndexedDB minimal, sans dependance : deux magasins seulement.
//   `data`   — l'etat complet de l'application, une cle par collection.
//   `outbox` — la file des ecritures en attente, ordonnee par `seq`.

const DB_NAME = 'turi-kout';
const DB_VERSION = 1;

export interface OutboxRow {
  opId: string;
  seq: number;
  type: string;
  payload: unknown;
  queuedAt: number;
}

let handle: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (handle) return handle;
  handle = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: 'opId' });
        store.createIndex('seq', 'seq');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return handle;
}

function run<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = work(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export function get<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('data', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function put(key: string, value: unknown): Promise<unknown> {
  return run('data', 'readwrite', (s) => s.put(value, key));
}

/** Ecrit plusieurs cles dans une seule transaction. */
export function putMany(entries: Record<string, unknown>): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction('data', 'readwrite');
        const store = tx.objectStore('data');
        for (const [key, value] of Object.entries(entries)) store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

// --- File d'attente --------------------------------------------------------

export function enqueue(row: OutboxRow): Promise<unknown> {
  return run('outbox', 'readwrite', (s) => s.put(row));
}

/** Les `limit` plus anciennes operations en attente, dans l'ordre d'emission. */
export function pending(limit = 500): Promise<OutboxRow[]> {
  return open().then(
    (db) =>
      new Promise<OutboxRow[]>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readonly');
        const request = tx.objectStore('outbox').index('seq').getAll(undefined, limit);
        request.onsuccess = () => resolve(request.result as OutboxRow[]);
        request.onerror = () => reject(request.error);
      }),
  );
}

export function pendingCount(): Promise<number> {
  return run<number>('outbox', 'readonly', (s) => s.count());
}

export function dequeue(opIds: string[]): Promise<void> {
  if (opIds.length === 0) return Promise.resolve();
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        for (const id of opIds) store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export function clearAll(): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['data', 'outbox'], 'readwrite');
        tx.objectStore('data').clear();
        tx.objectStore('outbox').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}
