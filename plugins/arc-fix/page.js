'use strict';
// The plugin's page. It runs in a sandboxed frame: relative URLs only, no cookies, no storage.
// The frame cannot load Vetro's design-system/tokens.css (it needs the dashboard's cookie), so the colours below are
// copied from it, the same way the bedtime plugin in vetro-plugins does.
module.exports = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta name="color-scheme" content="light dark">' +
'<style>' +
':root{--bg:#080f23;--surface:#101c35;--raised:#192943;--border:#344360;--text:#f5f8ff;--muted:#aab8d1;--action:#123bb5;--ok:#7fcba0;--warn:#e2b867;--bad:#ef8a80}' +
'@media (prefers-color-scheme:light){:root{--bg:#f5f8ff;--surface:#fff;--raised:#eef2fb;--border:#c9d3e6;--text:#0b1430;--muted:#4a5878;--ok:#1e7a4a;--warn:#8a5a00;--bad:#b3261e}}' +
'*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}' +
'.panel{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px;margin:0 0 16px;max-width:760px}' +
'h2{margin:0 0 4px;font-size:16px;font-weight:500}p{margin:0}.muted{color:var(--muted)}' +
'.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}' +
'.chip{border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted)}' +
'.on{border-color:var(--ok);color:var(--ok)}.warn{border-color:var(--warn);color:var(--warn)}' +
'.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}label{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}' +
'button,select{height:36px;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:var(--raised);color:var(--text);font:inherit}' +
'button{cursor:pointer}button.primary{background:var(--action);border-color:var(--action);color:#f5f8ff;font-weight:600}' +
'button:disabled,select:disabled{opacity:.6;cursor:default}' +
'.err{border:1px solid var(--bad);color:var(--bad);border-radius:8px;padding:8px 12px;margin:12px 0 0}' +
'summary{cursor:pointer;font-weight:500}pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--muted);margin:12px 0 0}' +
'</style>' +
'<body><div class="panel"><h2>ARC receiver fix</h2>' +
'<p class="muted">For receivers like the Yamaha RX-V375 that go silent when a movie switches to Dolby. ' +
'While this plugin is on, it resets the receiver by itself and the movie keeps playing.</p>' +
'<div class="chips" id="chips"></div>' +
'<div class="row"><button id="reset" class="primary">Reset receiver now</button>' +
'<label>Wait <select id="delay"></select></label><label>Port <select id="port"></select></label>' +
'<button id="refresh">Refresh</button></div><div id="err"></div></div>' +
'<div class="panel"><details><summary>Log</summary><pre id="log"></pre></details></div>' +
'<script>' +
'var $=function(i){return document.getElementById(i)},busy=false;' +
'function chip(t,c){var s=document.createElement("span");s.className="chip "+(c||"");s.textContent=t;$("chips").appendChild(s)}' +
'function opt(sel,v,t,on){var o=document.createElement("option");o.value=v;o.textContent=t;if(on)o.selected=true;sel.appendChild(o)}' +
'function show(d){var r=d.receiver||{},st=d.stream||{},auto=r.port||3;$("chips").textContent="";' +
'chip(d.running===true?"Watching":d.running===false?"Not running":"State unknown",d.running===true?"on":"warn");' +
'chip(r.available?(r.name||"AVR")+" \\u00b7 HDMI "+(r.port||auto):"No CEC receiver detected \\u00b7 fallback HDMI "+auto,r.available?"on":"");' +
'if(st.codec)chip("Stream: "+st.codec+(st.spdif?" \\u00b7 "+st.spdif:""));' +
'$("err").textContent="";var e=d.error||d.probeError;if(e){var x=document.createElement("div");x.className="err";x.textContent=e;$("err").appendChild(x)}' +
'{$("delay").textContent="";[1,2,3,4,5,6,8,10].forEach(function(n){opt($("delay"),n,n+" s"+(n===4?" (default)":""),n===d.delaySeconds)});' +
'$("port").textContent="";opt($("port"),"auto","Auto (HDMI "+auto+")",!d.port);[1,2,3,4].forEach(function(n){opt($("port"),n,"HDMI "+n,d.port===n)})}' +
'$("log").textContent=d.log||"(empty)"}' +
'function call(path,opts){busy=true;[].forEach.call(document.querySelectorAll("button,select"),function(b){b.disabled=true});' +
'return fetch(path,opts).then(function(r){return r.json().then(function(j){if(!r.ok)throw Error(j.error||("HTTP "+r.status));return j})}).then(show)' +
'.catch(function(e){$("err").textContent="";var x=document.createElement("div");x.className="err";x.textContent=e.message;$("err").appendChild(x)})' +
'.then(function(){busy=false;[].forEach.call(document.querySelectorAll("button,select"),function(b){b.disabled=false})})}' +
'function post(a){var p=$("port").value;return call("action",{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:a,delaySeconds:+$("delay").value,port:p==="auto"?null:+p})})}' +
'$("reset").onclick=function(){post("trigger")};$("delay").onchange=$("port").onchange=function(){post("configure")};$("refresh").onclick=function(){call("status")};' +
'call("status");' +
'</script></body>';
