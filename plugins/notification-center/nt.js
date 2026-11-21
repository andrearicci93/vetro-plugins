// Logic of the companion web app, served by the Shard (the app on the TV is only a thin loader, see README).
// It runs inside the app, with the app's `notification` privilege. Plain ES5.
(function () {
  'use strict';
  if (window.__ncLoaded) { return; }
  window.__ncLoaded = true;

  var BASES = ['http://127.0.0.1:8099'];
  var NOTES_PATH = '/plugins/notification-center/api/notifications';
  var SEEN_KEY = 'nc_seen', STAY_MS = 8000, WATCH_MS = 5000;
  var logEl = document.getElementById('log');
  var apiGood = null, busy = false;


  // Screen shown while the app is open: a One UI style card (EN/PT by the TV language). The banner itself is the TV's native one.
  var PT = /^pt/i.test(navigator.language || '');
  var TX = PT ? { wait: 'Centro de Notifica\u00E7\u00F5es', ready: '\u00C0 espera de avisos', sent: 'Aviso enviado', err: 'Sem liga\u00E7\u00E3o ao Shard' }
              : { wait: 'Notification Center', ready: 'Waiting for notifications', sent: 'Notification sent', err: 'Cannot reach the Shard' };
  var COL = { info: '#2f7bff', ok: '#2fc28b', warn: '#f5a524', alert: '#f0506e' };
  var ICO = { info: '\u2139\uFE0F', ok: '\u2705', warn: '\u26A0\uFE0F', alert: '\uD83D\uDD34' };
  var cardEl = null;
  (function buildUi() {
    var st = document.createElement('style');
    st.textContent = 'body{margin:0;background:radial-gradient(circle at 30% 20%,#17203a,#07090f);color:#eef2f9;font-family:SamsungOne,"Segoe UI",sans-serif}' +
      '#nc{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:1100px;max-width:90%;text-align:center}' +
      '#nc h1{font-size:44px;font-weight:600;margin:0 0 8px}#nc p{font-size:28px;color:#8b96ab;margin:0 0 40px}' +
      '#nc .card{display:flex;gap:28px;align-items:center;text-align:left;background:rgba(255,255,255,.08);border-radius:36px;padding:34px 42px;border-left:12px solid var(--c);margin-top:24px}' +
      '#nc .ic{width:96px;height:96px;border-radius:50%;background:var(--c);display:grid;place-items:center;font-size:48px;flex:none}' +
      '#nc .t{font-size:38px;font-weight:600}#nc .m{font-size:30px;color:#c4cde0;margin-top:6px}#log{display:none}';
    document.head.appendChild(st);
    cardEl = document.createElement('div'); cardEl.id = 'nc';
    cardEl.innerHTML = '<h1></h1><p></p><div id="ncl"></div>';
    cardEl.getElementsByTagName('h1')[0].textContent = '\uD83D\uDD14 ' + TX.wait;
    cardEl.getElementsByTagName('p')[0].textContent = TX.ready;
    document.body.appendChild(cardEl);
  })();
  function showCard(n) {
    if (!cardEl) { return; }
    var c = COL[n.level] || COL.info, d = document.createElement('div');
    d.className = 'card'; d.style.setProperty('--c', c);
    var ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = ICO[n.level] || ICO.info;
    var b = document.createElement('div'), t = document.createElement('div'), m = document.createElement('div');
    t.className = 't'; t.textContent = n.title || ''; m.className = 'm'; m.textContent = n.message || '';
    b.appendChild(t); b.appendChild(m); d.appendChild(ic); d.appendChild(b);
    var host = document.getElementById('ncl'); host.appendChild(d);
    cardEl.getElementsByTagName('p')[0].textContent = TX.sent;
  }

  function now() { var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; } return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function log(cls, text) {
    if (!logEl) { return; }
    var line = document.createElement('div');
    line.className = cls; line.textContent = now() + '  ' + text;
    logEl.appendChild(line);
    while (logEl.childNodes.length > 14) { logEl.removeChild(logEl.firstChild); }
  }

  function xhrGet(base, cb) {
    var x = new XMLHttpRequest(), done = false;
    function end(err, text) { if (!done) { done = true; cb(err, text); } }
    try {
      x.open('GET', base + NOTES_PATH); x.timeout = 4000;
      x.onload = function () { if (x.status === 200) { end(null, x.responseText); } else { end('http ' + x.status); } };
      x.onerror = function () { end('network'); };
      x.ontimeout = function () { end('timeout'); };
      x.send();
    } catch (e) { end('blocked'); }
  }
  function scriptGet(base, cb) {
    var s = document.createElement('script'), done = false, t;
    function end(err, data) {
      if (done) { return; }
      done = true; clearTimeout(t); window.__ncNotes = undefined;
      if (s.parentNode) { s.parentNode.removeChild(s); }
      cb(err, data);
    }
    window.__ncNotes = function (d) { end(null, d); };
    s.onerror = function () { end('network'); };
    t = setTimeout(function () { end('timeout'); }, 5000);
    s.src = base + NOTES_PATH + '?js=1&t=' + new Date().getTime();
    (document.head || document.documentElement).appendChild(s);
  }
  function fetchQueue(done) {
    var list = apiGood ? [apiGood] : BASES, i = 0, errors = [];
    (function next() {
      if (i >= list.length) { return done(errors.join('; ') || 'no address'); }
      var base = list[i++];
      xhrGet(base, function (err, text) {
        if (!err) { try { apiGood = base; return done(null, JSON.parse(text).notifications || []); } catch (e) { err = 'json'; } }
        scriptGet(base, function (err2, data) {
          if (!err2) { apiGood = base; return done(null, (data && data.notifications) || []); }
          errors.push(base + ' xhr:' + err + ' script:' + err2); next();
        });
      });
    })();
  }

  function post(title, body, cb) {
    try {
      if (!window.Notification) { return cb('window.Notification is missing'); }
      var show = function () { try { new Notification(title, { body: body }); cb(null); } catch (e) { cb('new Notification: ' + e.message); } };
      if (Notification.permission === 'granted') { return show(); }
      var r = Notification.requestPermission(function (p) { if (p === 'granted') { show(); } else { cb('permission ' + p); } });
      if (r && r.then) { r.then(function (p) { if (p === 'granted') { show(); } else { cb('permission ' + p); } }); }
    } catch (e) { cb(e.message); }
  }

  // On start, on resume and every few seconds while visible: post what is new, stay open while the banner shows, then exit.
  function check(why) {
    if (busy) { return; }
    busy = true;
    fetchQueue(function (err, list) {
      if (err) { busy = false; return log('err', why + ': Shard unreachable (' + err + ')'); }
      var seen = {}; try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (e) { seen = {}; }
      var fresh = list.filter(function (n) { return !seen[n.id]; });
      if (!fresh.length) { busy = false; return log('inf', why + ': nothing new'); }
      var pending = fresh.length;
      fresh.forEach(function (n) {
        seen[n.id] = 1; showCard(n);
        post(n.title || 'Notification', n.message || '', function (e) {
          log(e ? 'err' : 'ok', (n.title || 'Notification') + ': ' + (e || 'posted'));
          pending -= 1;
          if (pending) { return; }
          try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (x) { /* storage unavailable */ }
          busy = false;
          // Leaving too early hides the banner: stay open while it is on screen.
          setTimeout(function () { try { tizen.application.getCurrentApplication().exit(); } catch (x) { /* not on a TV */ } }, STAY_MS);
        });
      });
    });
  }

  check('start');
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { check('resume'); } });
  setInterval(function () { if (document.visibilityState !== 'hidden') { check('watch'); } }, WATCH_MS);
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 10009 || e.keyCode === 27) { try { tizen.application.getCurrentApplication().exit(); } catch (x) { /* not on a TV */ } }
  });
})();
