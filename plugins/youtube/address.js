'use strict';
// Which address the YouTube app reaches the proxy on, and who may talk to it. Plain ES5, no TV commands.
//
// On some firmware (a 2025 Frame on Tizen 9 measured it) apps cannot connect to 127.x at all, so the YouTube app never reaches a
// proxy on 127.0.0.2 and, because the proxy list ends in direct://, silently connects straight to YouTube: ads stay.
// There the proxy has to be on the TV's own network address. That address is open to the LAN unless it is checked, so the
// proxy only accepts connections that come from the TV itself (see isLocal).

// "::ffff:192.168.1.5" is the same peer as "192.168.1.5".
function normalize(addr) {
    var a = String(addr || '').toLowerCase().replace(/%.*$/, '');
    var m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    return m ? m[1] : a;
}

// ifaces: the shape of os.networkInterfaces(). Every address the TV itself has, normalised.
function ownAddresses(ifaces) {
    var list = [];
    Object.keys(ifaces || {}).forEach(function (name) {
        (ifaces[name] || []).forEach(function (a) { if (a && a.address) list.push(normalize(a.address)); });
    });
    return list;
}

// True when the peer is the TV talking to itself: loopback, or one of its own addresses. Anything else (another device on the
// network) is not allowed to use the proxy.
function isLocal(remote, ifaces) {
    var a = normalize(remote);
    if (!a) return false;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || a === '::1') return true;
    return ownAddresses(ifaces).indexOf(a) >= 0;
}

// The TV's own IPv4 address on the network (not loopback, not link-local), or null. The first one found: a TV has one.
function lanAddress(ifaces) {
    var found = null;
    Object.keys(ifaces || {}).forEach(function (name) {
        (ifaces[name] || []).forEach(function (a) {
            if (found || !a || a.internal || (a.family !== 'IPv4' && a.family !== 4)) return;
            if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(a.address) || /^(127|169\.254)\./.test(a.address)) return;
            found = a.address;
        });
    });
    return found;
}

// The Tizen major version out of /etc/tizen-release ("Tizen6/TV 6.0.0" on a Q80A), or 0 when it cannot be told.
function tizenMajor(text) {
    var m = /(\d+)\.\d+/.exec(String(text || ''));
    return m ? parseInt(m[1], 10) : 0;
}

// 'loopback' (127.0.0.2, the default everywhere it works) or 'lan' (the TV's own address).
// setting: the plugin's config.json "proxy": "loopback" | "lan" | anything else means automatic = 'lan' from Tizen 9 on.
function chooseMode(setting, tizen) {
    if (setting === 'loopback' || setting === 'lan') return setting;
    return tizen >= 9 ? 'lan' : 'loopback';
}

module.exports = { normalize: normalize, ownAddresses: ownAddresses, isLocal: isLocal, lanAddress: lanAddress, tizenMajor: tizenMajor, chooseMode: chooseMode };
