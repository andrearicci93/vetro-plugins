'use strict';
var dgram = require('dgram');
var isPrivateIpv4 = require('./target');
var service = '_wled._tcp.local';

// DNS names can refer back to earlier labels in the same packet.
function nameAt(packet, offset) {
    var labels = [], end, length;
    for (var hops = 0; hops < 64 && offset < packet.length; hops++) {
        length = packet[offset++];
        if (!length) return {name:labels.join('.'), end:end || offset};
        if ((length & 192) === 192 && offset < packet.length) {
            end = end || offset + 1;
            offset = ((length & 63) << 8) | packet[offset];
        } else {
            if (length > 63 || offset + length > packet.length) break;
            labels.push(packet.toString('utf8', offset, offset + length));
            offset += length;
        }
    }
    throw Error('Invalid DNS name');
}

function instance(packet) {
    if (packet.length < 12 || !(packet[2] & 128)) return;
    var offset = 12, i;
    for (i = 0; i < packet.readUInt16BE(4); i++) offset = nameAt(packet, offset).end + 4;
    while (offset < packet.length) {
        var owner = nameAt(packet, offset);
        if (owner.end + 10 > packet.length) return;
        var type = packet.readUInt16BE(owner.end);
        var size = packet.readUInt16BE(owner.end + 8);
        offset = owner.end + 10;
        if (offset + size > packet.length) return;
        if (type === 12 && owner.name.toLowerCase() === service && packet.readUInt32BE(owner.end + 4)) {
            var target = nameAt(packet, offset).name;
            if (target.toLowerCase().slice(-service.length-1) === '.' + service)
                return target.slice(0, -service.length-1);
        }
        offset += size;
    }
}

module.exports = function discover() {
    return new Promise(function(resolve, reject) {
        var socket = dgram.createSocket('udp4'), devices = {}, count = 0, done = false;
        var hex = '000000000001000000000000055f776c6564045f746370056c6f63616c00000c0001';
        var query = new Buffer(hex, 'hex');
        function finish(error) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { socket.close(); } catch (_) {}
            if (error) reject(error);
            else resolve(Object.keys(devices).sort().map(function(address) {
                return {address:address, name:devices[address]};
            }));
        }
        var timer = setTimeout(finish, 3000);
        socket.on('error', finish);
        socket.on('message', function(packet, peer) {
            if (peer.port !== 5353 || !isPrivateIpv4(peer.address)) return;
            if (!Object.prototype.hasOwnProperty.call(devices, peer.address) && count >= 64) return;
            try {
                var name = instance(packet);
                if (name) {
                    if (!Object.prototype.hasOwnProperty.call(devices, peer.address)) count++;
                    devices[peer.address] = name;
                }
            } catch (_) { /* Ignore malformed advertisements. */ }
        });
        socket.send(query, 0, query.length, 5353, '224.0.0.251');
    });
};
