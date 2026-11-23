'use strict';
// Buffer helpers for every Node the TV may run. Node 4.4 has neither Buffer.alloc nor a working
// Buffer.from(string) (that one is TypedArray.from); current Node warns about `new Buffer`.
// Plain ES5, like the rest of the Shard.

var MODERN = typeof Buffer.alloc === 'function';

function alloc(size) {
    if (MODERN) return Buffer.alloc(size);
    var b = new Buffer(size);
    b.fill(0);
    return b;
}

function fromString(text) {
    return MODERN ? Buffer.from(String(text), 'utf8') : new Buffer(String(text), 'utf8');
}

function fromBytes(bytes) {
    return MODERN ? Buffer.from(bytes) : new Buffer(bytes);
}

module.exports = { alloc: alloc, fromString: fromString, fromBytes: fromBytes };
