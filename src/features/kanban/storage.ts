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
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('board', 'readwrite');
      tx.objectStore('board').put(cards, 'cards');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
