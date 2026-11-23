// Background service of the Notification Center companion app (Node.js in the TV's web service runtime).
// Vetro starts it (POST /apps/launch) each time a notification is queued in "banner" mode; it posts the native Samsung banner with
// webapis.postPlainNotification, without opening any app.
// It reads the queue from a file the Shard writes (no network, no Vetro key: it works with pairing on). If that file is missing it asks the
// Shard over the network, on the TV's own LAN address (loopback is not reachable from the service on every TV).
// The ids it has already shown are kept in a file of its own, so a restarted service never shows the same banner twice.
var QUEUE_FILE = '/tmp/notification-center-queue.json';
var SEEN_FILE = '/tmp/notification-center-seen.json';
var HOSTS = ['127.0.0.1'];
try {
  var ifs = require('os').networkInterfaces();
  Object.keys(ifs).forEach(function (k) { ifs[k].forEach(function (i) { if (i.family === 'IPv4' && !i.internal && HOSTS.indexOf(i.address) < 0) { HOSTS.push(i.address); } }); });
} catch (e) { /* keep loopback only */ }
var PATH = '/plugins/notification-center/api/notifications';
var EMOJI = { info: '\u2139\uFE0F', ok: '\u2705', warn: '\u26A0\uFE0F', alert: '\uD83D\uDD34' };
var seen = {};
try { seen = JSON.parse(require('fs').readFileSync(SEEN_FILE, 'utf8')) || {}; } catch (e) { seen = {}; }

function saveSeen() {
  try {
    var keys = Object.keys(seen);
    if (keys.length > 60) { keys.slice(0, keys.length - 60).forEach(function (k) { delete seen[k]; }); }
    require('fs').writeFileSync(SEEN_FILE, JSON.stringify(seen));
  } catch (e) { /* not writable: duplicates are possible only if the service restarts while a notification is still queued */ }
}
function show(n) {
  // The native banner takes plain text only, but it draws emoji: the icon (or the level's emoji) goes in front of the title.
  var head = n.icon || EMOJI[n.level] || '';
  var title = (head ? head + ' ' : '') + (n.title || 'Notification');
  try { webapis.postPlainNotification(title, n.message || '', parseInt(n.duration, 10) || 8); } catch (e) { /* API not available */ }
}
function handle(list) {
  var changed = false;
  list.forEach(function (n) {
    if (seen[n.id]) { return; }
    seen[n.id] = 1; changed = true;
    if (n.mode !== 'banner') { return; }                          // "full" and "both" are shown by the companion app screen
    if (n.expires && n.expires < Date.now()) { return; }          // too old to be worth showing
    show(n);
  });
  if (changed) { saveSeen(); }
}
function fromNetwork() {
  var i = 0;
  (function next() {
    if (i >= HOSTS.length) { return; }
    fetch('http://' + HOSTS[i++] + ':8099' + PATH + '?t=' + Date.now()).then(function (r) { if (!r.ok) { throw new Error('http ' + r.status); } return r.json(); }).then(function (d) {
      handle(d.notifications || []);
    }).catch(function () { next(); });
  })();
}
function check() {
  var d = null;
  try { d = JSON.parse(require('fs').readFileSync(QUEUE_FILE, 'utf8')); } catch (e) { d = null; }
  if (d && Array.isArray(d.notifications)) { handle(d.notifications); } else { fromNetwork(); }
}
module.exports.onStart = check;
module.exports.onRequest = check;
module.exports.onStop = function () {};
