(function () {
  "use strict";
  var BASES = ["http://127.0.0.1:8099"];
  var PATH = "/plugins/notification-center/api/nt.js";
  var logEl = document.getElementById("log"), i = 0;
  function say(t) { var d = document.createElement("div"); d.textContent = t; logEl.appendChild(d); }
  (function next() {
    if (i >= BASES.length) { say("Could not load nt.js from the Shard. Is it running?"); return; }
    var s = document.createElement("script");
    s.src = BASES[i++] + PATH + "?t=" + new Date().getTime();
    s.onerror = function () { say("nt.js failed: " + s.src.split("?")[0]); next(); };
    (document.head || document.documentElement).appendChild(s);
  })();
})();
