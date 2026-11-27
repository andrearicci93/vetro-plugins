'use strict';
var http = require('http');

// The wall-clock deadline also covers connect and a peer trickling bytes.
module.exports = function(address, pathname, timeout, body, cb, port) {
    var done = false, req, timer;
    function finish(error, status, text) {
        if(done)return;
        done=true;
        clearTimeout(timer);
        if(error && req)req.destroy();
        cb(error,status,text);
    }
    function expired(){finish(Error('WLED timed out'));}
    var options={host:address,port:port||80,path:pathname,method:body===null?'GET':'POST'};
    if(body!==null)options.headers={'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)};
    req=http.request(options,function(res){
        var chunks=[],size=0;
        res.on('data',function(chunk){
            if(done)return;
            size+=chunk.length;
            if(size>65536)return finish(Error('WLED response exceeds 64 KB'));
            chunks.push(chunk);
        });
        res.on('end',function(){finish(null,res.statusCode,Buffer.concat(chunks).toString('utf8'));});
        res.on('error',finish);
        res.on('aborted',function(){finish(Error('WLED response interrupted'));});
        res.on('close',function(){if(!done)finish(Error('WLED response closed'));});
    });
    req.on('error',finish);
    timer=setTimeout(expired,timeout);
    req.setTimeout(timeout,expired);
    req.end(body===null?undefined:body);
};
