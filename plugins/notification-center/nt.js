// Logic of the companion web app, served by the Shard (the app on the TV is only a thin loader, see README).
// It runs inside the app, with the app's `notification` privilege. Plain ES5.
(function () {
  'use strict';
  if (window.__ncLoaded) { return; }
  window.__ncLoaded = true;

  var BASES = ['http://127.0.0.1:8099'];
  // Also try the address this script was loaded from (the loader may have reached the Shard over the LAN).
  try {
    var me = document.currentScript && document.currentScript.src, o = me && /^(https?:\/\/[^\/]+)\/plugins\//.exec(me);
    if (o && BASES.indexOf(o[1]) < 0) { BASES.push(o[1]); }
  } catch (e) { /* ignore */ }
  var NOTES_PATH = '/plugins/notification-center/api/notifications';
  var SEEN_KEY = 'nc_seen', STAY_MS = 8000, WATCH_MS = 5000;
  var logEl = document.getElementById('log');
  var apiGood = null, busy = false;


  // Screen shown while the app is open: a One UI style card (EN/PT by the TV language). The banner itself is the TV's native one.
  // The language is a Shard setting (default English); it is applied as soon as the first answer from the Shard arrives.
  var DICT = {
    en: { wait: 'Notification Center', ready: 'Waiting for notifications', sent: 'Notification sent', back: 'Returning to the previous app in', err: 'Cannot reach the Shard' },
    pt: { wait: 'Centro de Notifica\u00E7\u00F5es', ready: '\u00C0 espera de avisos', sent: 'Aviso enviado', back: 'A voltar \u00E0 aplica\u00E7\u00E3o anterior em', err: 'Sem liga\u00E7\u00E3o ao Shard' }
  };
  var TX = DICT.en;
  var COL = { info: '#2f7bff', ok: '#2fc28b', warn: '#f5a524', alert: '#f0506e' };
  // One UI style line icons (24x24, round caps): info, done, warning, alert.
  var ICON_BODY = {
    info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="0.6" fill="#fff"/>',
    ok: '<circle cx="12" cy="12" r="9.5"/><path d="M7.6 12.6l3 3 5.8-6.4"/>',
    warn: '<path d="M12 3.8L21.2 20H2.8z"/><path d="M12 10v4.6"/><circle cx="12" cy="17.4" r="0.6" fill="#fff"/>',
    alert: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v6"/><circle cx="12" cy="16.6" r="0.6" fill="#fff"/>'
  };
  function iconSvg(level, size) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (ICON_BODY[level] || ICON_BODY.info) + '</svg>';
  }
  var cardEl = null;
  (function buildUi() {
    var st = document.createElement('style');
    st.textContent = 'body{margin:0;background:radial-gradient(circle at 30% 20%,#17203a,#07090f);color:#eef2f9;font-family:SamsungOne,"Segoe UI",sans-serif}' +
      '#nc{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:1100px;max-width:90%;text-align:center}' +
      '#nc h1{font-size:44px;font-weight:600;margin:0 0 8px}#nc p{font-size:28px;color:#8b96ab;margin:0 0 40px}' +
      '#nc .card{display:flex;gap:28px;align-items:center;text-align:left;background:rgba(255,255,255,.08);border-radius:36px;padding:34px 42px;border-left:12px solid var(--c);margin-top:24px}' +
      '#nc .ic{width:96px;height:96px;border-radius:50%;background:var(--c);display:grid;place-items:center;flex:none}' +
      '#nc .t{font-size:38px;font-weight:600}#nc .m{font-size:30px;color:#c4cde0;margin-top:6px}#log{display:none}';
    document.head.appendChild(st);
    cardEl = document.createElement('div'); cardEl.id = 'nc';
    cardEl.innerHTML = '<h1></h1><p></p><div id="ncl"></div>';
    document.body.appendChild(cardEl);
    applyLang('en');
  })();
  function applyLang(l) {
    TX = DICT[l] || DICT.en;
    if (!cardEl) { return; }
    cardEl.getElementsByTagName('h1')[0].textContent = '\uD83D\uDD14 ' + TX.wait;
    if (!document.getElementById('ncl').firstChild) { cardEl.getElementsByTagName('p')[0].textContent = TX.ready; }
  }
  function showCard(n) {
    if (!cardEl) { return; }
    var c = COL[n.level] || COL.info, d = document.createElement('div');
    d.className = 'card'; d.style.setProperty('--c', c);
    var ic = document.createElement('div'); ic.className = 'ic'; ic.innerHTML = iconSvg(n.level, 56);
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
        if (!err) { try { apiGood = base; var jd = JSON.parse(text); applyLang(jd.lang); return done(null, jd.notifications || []); } catch (e) { err = 'json'; } }
        scriptGet(base, function (err2, data) {
          if (!err2) { apiGood = base; applyLang(data && data.lang); return done(null, (data && data.notifications) || []); }
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

  var cdTimer = null;
  function countdown(sec) {
    if (!cardEl || cdTimer) { return; }
    var el = document.createElement('div');
    el.style.cssText = 'margin-top:48px;color:#8b96ab;font-size:34px';
    cardEl.appendChild(el);
    (function tick() {
      el.innerHTML = '';
      var lbl = document.createElement('div'), num = document.createElement('div');
      lbl.textContent = TX.back;
      num.textContent = String(sec);
      num.style.cssText = 'font-size:220px;font-weight:700;line-height:1.05;color:#fff';
      el.appendChild(lbl); el.appendChild(num);
      if (sec <= 0) { return; }
      sec -= 1; cdTimer = setTimeout(tick, 1000);
    })();
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
      // mode: 'banner' = native Samsung banner only, 'full' = full-screen card only, anything else = both.
      var onlyBanner = fresh.every(function (n) { return n.mode === 'banner'; });
      if (cardEl) { cardEl.style.display = onlyBanner ? 'none' : ''; }
      fresh.forEach(function (n) {
        seen[n.id] = 1;
        if (n.mode !== 'banner') { showCard(n); }
        (n.mode === 'full' ? function (t, b, cb) { cb(null); } : post)(n.title || 'Notification', n.message || '', function (e) {
          log(e ? 'err' : 'ok', (n.title || 'Notification') + ': ' + (e || 'posted'));
          pending -= 1;
          if (pending) { return; }
          try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (x) { /* storage unavailable */ }
          busy = false; countdown(Math.round(STAY_MS / 1000));
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
