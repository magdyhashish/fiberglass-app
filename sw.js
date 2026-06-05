// ── نظام فايبرجلاس - Service Worker ──
var CACHE_NAME = 'fiberglass-v' + Date.now(); // رقم جديد مع كل deploy
var FB_URL = 'https://milano-fbe97-default-rtdb.firebaseio.com';

var STATIC_FILES = ['./index.html', './manifest.json'];

// تنصيب - skipWaiting عشان التحديث يطبق فوري
self.addEventListener('install', function(e){
  self.skipWaiting(); // فوري بدون انتظار
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(STATIC_FILES);
    })
  );
});

// تفعيل - امسح الكاش القديم فوري
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){
      return self.clients.claim(); // تحكم في كل التابات الحالية فوري
    })
  );
});

// اعتراض الطلبات
self.addEventListener('fetch', function(e){
  var req = e.request;
  var url = req.url;

  // Firebase writes أوفلاين
  if(url.startsWith(FB_URL) && req.method !== 'GET'){
    e.respondWith(handleFirebaseWrite(req));
    return;
  }

  // Firebase reads
  if(url.startsWith(FB_URL) && req.method === 'GET'){
    e.respondWith(handleFirebaseRead(req));
    return;
  }

  // HTML pages - Network First عشان دايماً تاخد أحدث نسخة
  if(req.destination === 'document' || url.endsWith('.html')){
    e.respondWith(
      fetch(req, {cache: 'no-cache'}).then(function(resp){
        if(resp && resp.status === 200){
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(req, clone); });
        }
        return resp;
      }).catch(function(){
        return caches.match(req);
      })
    );
    return;
  }

  // باقي الملفات - Cache First
  e.respondWith(
    caches.match(req).then(function(cached){
      return cached || fetch(req).then(function(resp){
        if(resp && resp.status === 200){
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(req, clone); });
        }
        return resp;
      });
    }).catch(function(){
      return caches.match('./index.html');
    })
  );
});

// Firebase Write Handler
function handleFirebaseWrite(req){
  return req.clone().text().then(function(body){
    return fetch(req.clone()).then(function(resp){
      return resp;
    }).catch(function(){
      return saveToQueue({url:req.url,method:req.method,body:body,ts:Date.now()}).then(function(){
        self.clients.matchAll().then(function(clients){
          clients.forEach(function(c){ c.postMessage({type:'OFFLINE_QUEUED'}); });
        });
        return new Response(JSON.stringify({name:'offline_'+Date.now()}),{status:200,headers:{'Content-Type':'application/json'}});
      });
    });
  });
}

function handleFirebaseRead(req){
  return fetch(req.clone()).then(function(resp){
    if(resp && resp.status === 200){
      var clone = resp.clone();
      clone.json().then(function(data){ saveToIDB('fb_cache',req.url,data); }).catch(function(){});
    }
    return resp;
  }).catch(function(){
    return getFromIDB('fb_cache',req.url).then(function(data){
      return new Response(JSON.stringify(data||null),{status:200,headers:{'Content-Type':'application/json'}});
    });
  });
}

// IndexedDB
function openIDB(){
  return new Promise(function(resolve,reject){
    var r=indexedDB.open('fiberglass-db',2);
    r.onupgradeneeded=function(e){
      var db=e.target.result;
      if(!db.objectStoreNames.contains('queue'))db.createObjectStore('queue',{keyPath:'id',autoIncrement:true});
      if(!db.objectStoreNames.contains('cache'))db.createObjectStore('cache',{keyPath:'url'});
    };
    r.onsuccess=function(e){resolve(e.target.result)};
    r.onerror=reject;
  });
}
function saveToQueue(item){return openIDB().then(function(db){return new Promise(function(res,rej){var tx=db.transaction('queue','readwrite');tx.objectStore('queue').add(item);tx.oncomplete=res;tx.onerror=rej})});}
function getAllFromQueue(){return openIDB().then(function(db){return new Promise(function(res,rej){var tx=db.transaction('queue','readonly');var r=tx.objectStore('queue').getAll();r.onsuccess=function(){res(r.result)};r.onerror=rej})});}
function deleteFromQueue(id){return openIDB().then(function(db){return new Promise(function(res,rej){var tx=db.transaction('queue','readwrite');tx.objectStore('queue').delete(id);tx.oncomplete=res;tx.onerror=rej})});}
function saveToIDB(store,key,value){return openIDB().then(function(db){return new Promise(function(res){var tx=db.transaction(store,'readwrite');tx.objectStore(store).put({url:key,data:value,time:Date.now()});tx.oncomplete=res;tx.onerror=res})}).catch(function(){});}
function getFromIDB(store,key){return openIDB().then(function(db){return new Promise(function(res){var tx=db.transaction(store,'readonly');var r=tx.objectStore(store).get(key);r.onsuccess=function(){res(r.result?r.result.data:null)};r.onerror=function(){res(null)}})}).catch(function(){return null});}

// Sync
self.addEventListener('sync',function(e){if(e.tag==='sync-firebase')e.waitUntil(syncQueue())});
self.addEventListener('message',function(e){if(e.data&&e.data.type==='TRY_SYNC')syncQueue().then(function(n){self.clients.matchAll().then(function(clients){clients.forEach(function(c){c.postMessage({type:'SYNC_DONE',synced:n})})})})});
function syncQueue(){return getAllFromQueue().then(function(items){if(!items||!items.length)return 0;var done=0;return Promise.all(items.map(function(item){return fetch(item.url,{method:item.method,headers:{'Content-Type':'application/json'},body:item.body}).then(function(r){if(r.ok){done++;return deleteFromQueue(item.id)}}).catch(function(){})})).then(function(){return done})})}
