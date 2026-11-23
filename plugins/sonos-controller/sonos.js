'use strict';
// Local control of Sonos speakers over the LAN: the UPnP/SOAP services every player serves on port 1400.
// No cloud, no account. Action and argument names are taken from the player's own service descriptions
// (/xml/RenderingControl1.xml and /xml/GroupRenderingControl1.xml):
//
//   RenderingControl       GetVolume / SetVolume (DesiredVolume) / GetMute / SetMute (DesiredMute)
//                          InstanceID 0, Channel Master. Sent to a room's main player, this is the room's
//                          volume: a home theatre (Playbar + surrounds + Sub) follows it as one.
//   GroupRenderingControl  GetGroupVolume / SetGroupVolume / GetGroupMute / SetGroupMute / SnapshotGroupVolume
//                          InstanceID 0, sent to the group's coordinator. Changes every room in the group,
//                          keeping their relative levels.
//   ZoneGroupTopology      GetZoneGroupState: rooms, their players' addresses and how they are grouped.
//
// Plain ES5: the TV may run Node 4.4.

var http = require('http');

var DEFAULT_PORT = 1400;
var TIMEOUT_MS = 4000;
var MAX_RESPONSE = 1048576;

var SERVICES = {
    rendering: { path: '/MediaRenderer/RenderingControl/Control', urn: 'urn:schemas-upnp-org:service:RenderingControl:1' },
    group: { path: '/MediaRenderer/GroupRenderingControl/Control', urn: 'urn:schemas-upnp-org:service:GroupRenderingControl:1' },
    topology: { path: '/ZoneGroupTopology/Control', urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' }
};

var HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
var ADDRESS_RE = /^([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/;
var LOCATION_RE = /^https?:\/\/([^\/:]+)(?::(\d+))?/;

// "192.168.1.3" or "192.168.1.3:1400" -> { host, port }. Throws on anything else.
function parseAddress(text) {
    var m = ADDRESS_RE.exec(String(text == null ? '' : text).trim());
    if (!m || !HOST_RE.test(m[1])) throw new Error('Not a speaker address: ' + text);
    var port = m[2] ? Number(m[2]) : DEFAULT_PORT;
    if (port < 1 || port > 65535) throw new Error('Not a speaker address: ' + text);
    return { host: m[1], port: port };
}

function formatAddress(a) {
    return a.port === DEFAULT_PORT ? a.host : a.host + ':' + a.port;
}

function unescapeXml(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
        .replace(/&amp;/g, '&');
}

function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tagValue(xml, name) {
    var m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml);
    return m ? m[1] : null;
}

function soapError(action, status, text) {
    var code = tagValue(text, 'errorCode');
    var e = new Error('Sonos refused ' + action + ' (HTTP ' + status + (code ? ', UPnP error ' + code : '') + ')');
    e.upnpCode = code ? Number(code) : null;
    return e;
}

// One SOAP call. args: [[name, value], ...] in the order the service lists them. Resolves to the raw
// response body (XML); network failures reject with e.network = true so callers can look the speaker up again.
function call(address, serviceKey, action, args, timeoutMs) {
    var service = SERVICES[serviceKey];
    var inner = (args || []).map(function (a) { return '<' + a[0] + '>' + escapeXml(a[1]) + '</' + a[0] + '>'; }).join('');
    var body = '<?xml version="1.0" encoding="utf-8"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        '<s:Body><u:' + action + ' xmlns:u="' + service.urn + '">' + inner + '</u:' + action + '></s:Body></s:Envelope>';
    return new Promise(function (resolve, reject) {
        var settled = false, timer = null, req;
        function fail(e, network) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (network) e.network = true;
            reject(e);
        }
        try {
            req = http.request({
                host: address.host,
                port: address.port || DEFAULT_PORT,
                method: 'POST',
                path: service.path,
                agent: false,
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    'SOAPACTION': '"' + service.urn + '#' + action + '"',
                    'Content-Length': Buffer.byteLength(body),
                    'Connection': 'close'
                }
            }, function (res) {
                var chunks = [], size = 0;
                res.on('error', function (e) { fail(e, true); });
                res.on('data', function (c) {
                    size += c.length;
                    if (size > MAX_RESPONSE) { fail(new Error('Sonos answer too large')); res.destroy(); return; }
                    chunks.push(c);
                });
                res.on('end', function () {
                    if (settled) return;
                    var text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode !== 200) { fail(soapError(action, res.statusCode, text)); return; }
                    settled = true;
                    if (timer) clearTimeout(timer);
                    resolve(text);
                });
            });
        } catch (e) {
            fail(e, true);
            return;
        }
        req.on('error', function (e) {
            fail(new Error('Cannot reach the speaker at ' + formatAddress(address) + ' (' + (e.code || e.message) + ')'), true);
        });
        // One timer for the whole request, connecting included: req.setTimeout() only starts once the socket
        // is connected on Node 12 (the TV), so a speaker that never answers the connection would hold the
        // queue until the system gives up on it, about two minutes later. Cleared as soon as the call settles.
        timer = setTimeout(function () {
            timer = null;
            fail(new Error('The speaker at ' + formatAddress(address) + ' did not answer in time'), true);
            if (typeof req.destroy === 'function') req.destroy(); else req.abort();
        }, timeoutMs || TIMEOUT_MS);
        req.end(body);
    });
}

function readInt(text, name, action) {
    var v = tagValue(text, name);
    if (v === null || !/^\d+$/.test(v.trim())) throw new Error('Unexpected answer to ' + action);
    return Number(v.trim());
}

var MASTER = [['InstanceID', '0'], ['Channel', 'Master']];
var INSTANCE = [['InstanceID', '0']];

// mode 'room': RenderingControl on the room's player. mode 'group': GroupRenderingControl on the coordinator.
function getVolume(address, mode) {
    if (mode === 'group') {
        return call(address, 'group', 'GetGroupVolume', INSTANCE).then(function (t) { return readInt(t, 'CurrentVolume', 'GetGroupVolume'); });
    }
    return call(address, 'rendering', 'GetVolume', MASTER).then(function (t) { return readInt(t, 'CurrentVolume', 'GetVolume'); });
}

function setVolume(address, mode, volume) {
    var v = String(Math.max(0, Math.min(100, Math.round(volume))));
    if (mode === 'group') {
        // Sonos keeps the rooms' relative levels from the last snapshot; take one first.
        return call(address, 'group', 'SnapshotGroupVolume', INSTANCE).then(function () {
            return call(address, 'group', 'SetGroupVolume', INSTANCE.concat([['DesiredVolume', v]]));
        }).then(function () { return Number(v); });
    }
    return call(address, 'rendering', 'SetVolume', MASTER.concat([['DesiredVolume', v]])).then(function () { return Number(v); });
}

function getMute(address, mode) {
    if (mode === 'group') {
        return call(address, 'group', 'GetGroupMute', INSTANCE).then(function (t) { return readInt(t, 'CurrentMute', 'GetGroupMute') === 1; });
    }
    return call(address, 'rendering', 'GetMute', MASTER).then(function (t) { return readInt(t, 'CurrentMute', 'GetMute') === 1; });
}

function setMute(address, mode, muted) {
    var v = muted ? '1' : '0';
    if (mode === 'group') return call(address, 'group', 'SetGroupMute', INSTANCE.concat([['DesiredMute', v]])).then(function () { return !!muted; });
    return call(address, 'rendering', 'SetMute', MASTER.concat([['DesiredMute', v]])).then(function () { return !!muted; });
}

function attributes(text) {
    var out = {}, re = /([A-Za-z_][\w.-]*)="([^"]*)"/g, m;
    while ((m = re.exec(text))) out[m[1]] = unescapeXml(m[2]);
    return out;
}

// The answer of GetZoneGroupState -> { groups: [{ id, coordinator, members: [room] }], rooms: [room] }.
// room: { uuid, name, host, port, address, groupId, coordinator (uuid), isCoordinator }.
// Hidden members (the second half of a stereo pair and the like) are left out; satellites
// (surrounds, Sub) are separate <Satellite> elements and never listed as rooms.
function parseTopology(responseXml) {
    var state = tagValue(responseXml, 'ZoneGroupState');
    if (state === null) throw new Error('Unexpected answer to GetZoneGroupState');
    var xml = unescapeXml(state);
    var groups = [], rooms = [];
    var groupRe = /<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g, g;
    while ((g = groupRe.exec(xml))) {
        var ga = attributes(g[1]);
        var group = { id: ga.ID || '', coordinator: ga.Coordinator || '', members: [] };
        var memberRe = /<ZoneGroupMember\b([^>]*?)\/?>/g, m;
        while ((m = memberRe.exec(g[2]))) {
            var a = attributes(m[1]);
            if (!a.UUID || a.Invisible === '1') continue;
            var loc = LOCATION_RE.exec(a.Location || '');
            if (!loc) continue;
            var room = {
                uuid: a.UUID,
                name: a.ZoneName || a.UUID,
                host: loc[1],
                port: loc[2] ? Number(loc[2]) : DEFAULT_PORT,
                groupId: group.id,
                coordinator: group.coordinator,
                isCoordinator: a.UUID === group.coordinator
            };
            room.address = formatAddress(room);
            group.members.push(room);
            rooms.push(room);
        }
        if (group.members.length) groups.push(group);
    }
    rooms.sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
    return { groups: groups, rooms: rooms };
}

function getTopology(address, timeoutMs) {
    return call(address, 'topology', 'GetZoneGroupState', [], timeoutMs).then(parseTopology);
}

module.exports = {
    DEFAULT_PORT: DEFAULT_PORT,
    parseAddress: parseAddress,
    formatAddress: formatAddress,
    parseTopology: parseTopology,
    getTopology: getTopology,
    getVolume: getVolume,
    setVolume: setVolume,
    getMute: getMute,
    setMute: setMute,
    call: call
};
