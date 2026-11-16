'use strict';

/* On-device storage. Trades are JSON records; chart photos are Blobs in
   their own store so editing a note does not rewrite image bytes. */

const TJDB = (() => {
  const DB_NAME = 'trade-journal';
  const DB_VERSION = 1;
  let opening;

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser cannot store the journal (no IndexedDB).'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('trades')) {
          const trades = db.createObjectStore('trades', { keyPath: 'id' });
          trades.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains('images')) {
          const images = db.createObjectStore('images', { keyPath: 'id' });
          images.createIndex('tradeId', 'tradeId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
      request.onblocked = () => {
        opening = null;
        reject(new Error('Storage is busy in another tab. Close it and try again.'));
      };
    });
    return opening;
  }

  async function getMeta(key) {
    const db = await open();
    const row = await requestToPromise(db.transaction('meta').objectStore('meta').get(key));
    return row ? row.value : undefined;
  }

  async function setMeta(key, value) {
    const db = await open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await transactionDone(tx);
  }

  async function listTrades() {
    const db = await open();
    const rows = await requestToPromise(db.transaction('trades').objectStore('trades').getAll());
    return rows || [];
  }

  async function putTrade(trade) {
    const db = await open();
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').put(trade);
    await transactionDone(tx);
  }

  async function listImages() {
    const db = await open();
    const rows = await requestToPromise(db.transaction('images').objectStore('images').getAll());
    return rows || [];
  }

  async function putImage(image) {
    const db = await open();
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').put(image);
    await transactionDone(tx);
  }

  async function deleteImage(id) {
    const db = await open();
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').delete(id);
    await transactionDone(tx);
  }

  async function deleteTrade(id) {
    const db = await open();
    const tx = db.transaction(['trades', 'images'], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('trades').delete(id);
    const images = tx.objectStore('images');
    // Keep the transaction alive: schedule image deletes from the request
    // callback instead of awaiting, or IndexedDB will commit too early.
    const keysRequest = images.index('tradeId').getAllKeys(id);
    keysRequest.onsuccess = () => {
      for (const key of keysRequest.result || []) images.delete(key);
    };
    await done;
  }

  async function replaceAll(trades, images) {
    const db = await open();
    const tx = db.transaction(['trades', 'images', 'meta'], 'readwrite');
    tx.objectStore('trades').clear();
    tx.objectStore('images').clear();
    for (const trade of trades) tx.objectStore('trades').put(trade);
    for (const image of images) tx.objectStore('images').put(image);
    tx.objectStore('meta').put({ key: 'seeded', value: true });
    await transactionDone(tx);
  }

  return {
    getMeta,
    setMeta,
    listTrades,
    putTrade,
    listImages,
    putImage,
    deleteImage,
    deleteTrade,
    replaceAll,
  };
})();
