// ── نظام فايبرجلاس - Service Worker ──
var CACHE_NAME = 'fiberglass-v1';
var FB_URL = 'https://milano-fbe97-default-rtdb.firebaseio.com';

// الملفات اللي هتتخزن للشغل أوفلاين
var STATIC_FILES = [
  './index.html',
  './manifest.json'
];

// ── تنصيب: كاش الملفات الأساسية ──
self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_FILES);
    })
  );
});

// ── تفعيل: حذف الكاش القديم ──
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── اعتراض الطلبات ──
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = req.url;

  // طلبات Firebase (PUT/POST/DELETE) → لو أوفلاين، خزّنها في Queue
  if (url.startsWith(FB_URL) && req.method !== 'GET') {
    event.respondWith(handleFirebaseWrite(req));
    return;
  }

  // طلبات Firebase GET → حاول الشبكة، فشل → IndexedDB cache
  if (url.startsWith(FB_URL) && req.method === 'GET') {
    event.respondWith(handleFirebaseRead(req));
    return;
  }

  // باقي الطلبات → Cache first
  event.respondWith(
    caches.match(req).then(function(cached) {
      return cached || fetch(req).then(function(resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
        }
        return resp;
      });
    }).catch(function() {
      return caches.match('./index.html');
    })
  );
});

// ── معالجة كتابة Firebase ──
function handleFirebaseWrite(req) {
  return req.clone().text().then(function(body) {
    return fetch(req.clone()).then(function(resp) {
      // نجح → رد مباشرة
      return resp;
    }).catch(function() {
      // فشل (أوفلاين) → خزّن في Queue
      return saveToQueue({
        url: req.url,
        method: req.method,
        body: body,
        timestamp: Date.now()
      }).then(function() {
        // أرسل رسالة للتطبيق إن العملية اتخزنت
        self.clients.matchAll().then(function(clients) {
          clients.forEach(function(c) {
            c.postMessage({ type: 'OFFLINE_QUEUED', url: req.url });
          });
        });
        // رد وهمي ناجح عشان التطبيق ميوقفش
        return new Response(JSON.stringify({ name: 'offline_' + Date.now() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      });
    });
  });
}

// ── معالجة قراءة Firebase ──
function handleFirebaseRead(req) {
  return fetch(req.clone()).then(function(resp) {
    if (resp && resp.status === 200) {
      var clone = resp.clone();
      // خزّن آخر بيانات في IndexedDB
      clone.json().then(function(data) {
        saveToIDB('fb_cache', req.url, data);
      }).catch(function(){});
    }
    return resp;
  }).catch(function() {
    // أوفلاين → رجّع البيانات المخزنة
    return getFromIDB('fb_cache', req.url).then(function(data) {
      if (data) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('null', { status: 200 });
    });
  });
}

// ── IndexedDB helpers ──
function openIDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('fiberglass-db', 2);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'url' });
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function(e) { reject(e); };
  });
}

function saveToQueue(item) {
  return openIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add(item);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  });
}

function getAllFromQueue() {
  return openIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('queue', 'readonly');
      var req = tx.objectStore('queue').getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = reject;
    });
  });
}

function deleteFromQueue(id) {
  return openIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  });
}

function saveToIDB(store, key, value) {
  return openIDB().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put({ url: key, data: value, time: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = resolve; // مش مشكلة لو فشلت
    });
  }).catch(function(){});
}

function getFromIDB(store, key) {
  return openIDB().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(store, 'readonly');
      var req = tx.objectStore(store).get(key);
      req.onsuccess = function() {
        resolve(req.result ? req.result.data : null);
      };
      req.onerror = function() { resolve(null); };
    });
  }).catch(function() { return null; });
}

// ── Sync: لما يرجع النت، ارفع الـ Queue ──
self.addEventListener('sync', function(event) {
  if (event.tag === 'sync-firebase') {
    event.waitUntil(syncQueue());
  }
});

// ── Periodic sync backup + رصد الاتصال ──
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'TRY_SYNC') {
    syncQueue().then(function(count) {
      self.clients.matchAll().then(function(clients) {
        clients.forEach(function(c) {
          c.postMessage({ type: 'SYNC_DONE', synced: count });
        });
      });
    });
  }
});

function syncQueue() {
  return getAllFromQueue().then(function(items) {
    if (!items || items.length === 0) return 0;
    var done = 0;
    var promises = items.map(function(item) {
      return fetch(item.url, {
        method: item.method,
        headers: { 'Content-Type': 'application/json' },
        body: item.body
      }).then(function(resp) {
        if (resp.ok) {
          done++;
          return deleteFromQueue(item.id);
        }
      }).catch(function() {
        // لسه أوفلاين، خلّيها في الـ Queue
      });
    });
    return Promise.all(promises).then(function() { return done; });
  });
}
