/* Background notification worker. */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Hyperliquid Radar', body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Hyperliquid Radar', { body: data.body || '', tag: data.tag || data.event?.hash || 'hyperliquid-radar', data:{...(data.event || {}), url:data.url || '/'} }));
});
self.addEventListener('notificationclick', event => { event.notification.close(); const url=event.notification.data?.url || '/'; event.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => { const same=list.find(client => client.url.startsWith(self.location.origin)); return same ? same.focus() : clients.openWindow(url); })); });
