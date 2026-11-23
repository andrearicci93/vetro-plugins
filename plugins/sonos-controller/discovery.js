'use strict';
// Finds Sonos players on the LAN with an SSDP search (UDP multicast to 239.255.255.250:1900).
// Only a convenience: typing a speaker's IP address works without it, and some networks or
// TVs drop multicast. Plain ES5.

var dgram = require('dgram');
var compat = require('./compat.js');

var SEARCH = [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 1',
    'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
    '', ''
].join('\r\n');

var LOCATION_RE = /^LOCATION:\s*https?:\/\/([^\/:\s]+)(?::(\d+))?/im;
var SONOS_RE = /sonos|ZonePlayer/i;

// Returns { promise, cancel }. The promise resolves to a list of { host, port } (possibly empty) after
// windowMs, or earlier with what was found if cancel() is called. It never rejects.
function search(windowMs) {
    var found = [], seen = {}, socket = null, timer = null, resent = null, done = false, finish;
    var promise = new Promise(function (resolve) {
        finish = function () {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (resent) clearTimeout(resent);
            timer = resent = null;
            if (socket) { try { socket.close(); } catch (e) { /* already closed */ } }
            socket = null;
            resolve(found);
        };
    });
    try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) {
        finish();
        return { promise: promise, cancel: finish };
    }
    var message = compat.fromString(SEARCH);
    function send() {
        if (done || !socket) return;
        try { socket.send(message, 0, message.length, 1900, '239.255.255.250'); } catch (e) { /* network down */ }
    }
    socket.on('error', function () { finish(); });
    socket.on('message', function (msg) {
        var text = msg.toString('utf8');
        if (!SONOS_RE.test(text)) return;
        var m = LOCATION_RE.exec(text);
        if (!m) return;
        var key = m[1] + ':' + (m[2] || '1400');
        if (seen[key]) return;
        seen[key] = true;
        found.push({ host: m[1], port: m[2] ? Number(m[2]) : 1400 });
    });
    try {
        socket.bind(function () {
            send();
            resent = setTimeout(function () { resent = null; send(); }, 400);   // UDP may drop the first one
        });
    } catch (e) {
        finish();
    }
    timer = setTimeout(finish, windowMs || 2500);
    return { promise: promise, cancel: finish };
}

module.exports = { search: search };
