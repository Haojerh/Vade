import type { KanbanCard } from './kanban';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('orca-kanban', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('board');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readBoard(): Promise<KanbanCard[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('board').objectStore('board').get('cards');
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function writeBoard(cards: KanbanCard[]): Promise<void> {
  await updateBoard(() => cards);
}

/** Atomic read/modify/write keeps independent windows from overwriting each other's cards. */
export async function updateBoard(update: (cards: KanbanCard[]) => KanbanCard[]): Promise<KanbanCard[]> {
  const db = await database();
  try {
    return await new Promise<KanbanCard[]>((resolve, reject) => {
      const tx = db.transaction('board', 'readwrite');
      let next: KanbanCard[];
      const request = tx.objectStore('board').get('cards');
      request.onsuccess = () => {
        try {
          const previous: KanbanCard[] = request.result || [];
          next = update(previous);
          if (next.length !== previous.length || next.some((card, index) => card !== previous[index])) tx.objectStore('board').put(next, 'cards');
        }
        catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
