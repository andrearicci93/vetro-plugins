// Background service of the Notification Center companion app (Node.js in the TV's web service runtime).
// Vetro starts it (POST /apps/launch) each time a notification is queued in "banner" mode; it reads the Shard's queue and posts the native
// Samsung banner with webapis.postPlainNotification, without opening any app.
// The Shard is reached on the TV's own LAN address (found here), because loopback is not reachable from the service on every TV.
var HOSTS = ['127.0.0.1'];
try {
  var ifs = require('os').networkInterfaces();
  Object.keys(ifs).forEach(function (k) { ifs[k].forEach(function (i) { if (i.family === 'IPv4' && !i.internal && HOSTS.indexOf(i.address) < 0) { HOSTS.push(i.address); } }); });
} catch (e) { /* keep loopback only */ }
var PATH = '/plugins/notification-center/api/notifications';
var seen = {};
var EMOJI = { info: '\u2139\uFE0F', ok: '\u2705', warn: '\u26A0\uFE0F', alert: '\uD83D\uDD34' };
function check() {
  var i = 0;
  (function next() {
    if (i >= HOSTS.length) { return; }
    fetch('http://' + HOSTS[i++] + ':8099' + PATH + '?t=' + Date.now()).then(function (r) { if (!r.ok) { throw new Error('http ' + r.status); } return r.json(); }).then(function (d) {
      (d.notifications || []).forEach(function (n) {
        if (seen[n.id]) { return; }
        seen[n.id] = 1;
        if (n.mode !== 'banner') { return; }   // "full" and "both" are shown by the companion app screen
        // The native banner takes plain text only, but it draws emoji: the icon (or the level's emoji) goes in front of the title.
        var head = n.icon || EMOJI[n.level] || '';
        var title = (head ? head + ' ' : '') + (n.title || 'Notification');
        try { webapis.postPlainNotification(title, n.message || '', parseInt(n.duration, 10) || 8); } catch (e) { /* API not available */ }
      });
    }).catch(function () { next(); });
  })();
}
module.exports.onStart = check;
module.exports.onRequest = check;
module.exports.onStop = function () {};
