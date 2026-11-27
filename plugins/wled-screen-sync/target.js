'use strict';
var net = require('net');

module.exports = function isPrivateIpv4(address) {
    if (typeof address !== 'string' || net.isIP(address) !== 4) return false;
    var parts = address.split('.');
    var a = Number(parts[0]), b = Number(parts[1]);
    // Require canonical dotted decimal across Node and .NET runtimes.
    if (parts.map(Number).join('.') !== address) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
