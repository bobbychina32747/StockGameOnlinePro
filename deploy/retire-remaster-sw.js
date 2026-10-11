// Retire only the old test service worker and its own public shell cache.
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('stockgame-v2-%2Fremaster%2F-')).map(key=>caches.delete(key)))).then(()=>self.registration.unregister())));
