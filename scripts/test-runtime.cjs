'use strict';
// ES5 so the same lifecycle harness actually runs under Node 4.4 and newer TVs.
var fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
var EventEmitter = require('events').EventEmitter;
function fail(message) { throw new Error(message); }
function assert(value, message) { if (!value) fail(message); }
if (process.argv[2] === '--proxy-pipelined') {
    var net = require('net'), tls = require('tls');
    var proxyLib = require(path.join(__dirname, '..', 'plugins', 'youtube', 'proxy.js'));
    var nodeMajor = +(process.versions && String(process.versions.node).split('.')[0]) || 0;
    function mkBuf(v, enc) { return Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(v, enc) : new Buffer(v, enc); }
    function rmrf(dir) {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(function (n) {
            var p = path.join(dir, n);
            if (fs.statSync(p).isDirectory()) rmrf(p); else fs.unlinkSync(p);
        });
        fs.rmdirSync(dir);
    }
    var tmp = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'yt-pipe-')) : path.join(os.tmpdir(), 'yt-pipe-' + process.pid);
    if (!fs.existsSync(tmp)) fs.mkdirSync(tmp);
    var env = process.env;
    if (process.platform === 'win32') {
        var extra = ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\bin'].filter(function (d) { return fs.existsSync(d); });
        if (extra.length) {
            env = {};
            Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
            env.PATH = extra.join(path.delimiter) + path.delimiter + (process.env.PATH || '');
        }
    }
    fs.writeFileSync(path.join(tmp, 'leaf.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=www.youtube.com\n[v3]\nsubjectAltName=DNS:www.youtube.com\nbasicConstraints=CA:FALSE\n');
    var certGen = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.crt', '-days', '2', '-sha256', '-config', 'leaf.cnf'], { cwd: tmp, env: env, encoding: 'utf8' });
    assert(!certGen.error && certGen.status === 0, 'openssl failed: ' + (certGen.error ? certGen.error.message : certGen.stderr));
    var leaf = { key: fs.readFileSync(path.join(tmp, 'leaf.key')), cert: fs.readFileSync(path.join(tmp, 'leaf.crt'), 'utf8') };

    var upstream = tls.createServer({ key: leaf.key, cert: leaf.cert }, function (s) { s.on('error', function () {}); });
    var realNetConnect = net.connect, proxy = null, capSrv = null;
    function clean(err) {
        net.connect = realNetConnect;
        if (proxy) proxy.close(true);
        try { upstream.close(); } catch (e) {}
        try { if (capSrv) capSrv.close(); } catch (e) {}
        try { rmrf(tmp); } catch (e) {}
        if (err) { console.error(err.stack || err); process.exit(1); }
    }
    upstream.listen(0, '127.0.0.1', function () {
        var upPort = upstream.address().port;
        capSrv = net.createServer(function (s) {
            s.once('data', function (clientHello) {
                s.destroy();
                capSrv.close();
                net.connect = function (p, h) {
                    var host = (typeof p === 'object' && p) ? p.host : h;
                    return host === 'www.youtube.com' ? realNetConnect.call(net, upPort, '127.0.0.1') : realNetConnect.apply(net, arguments);
                };
                var probe = net.createServer();
                probe.listen(0, '127.0.0.1', function () {
                    var pPort = probe.address().port;
                    probe.close(function () {
                        proxy = proxyLib.createProxy({
                            host: '127.0.0.1', port: pPort, log: function () {}, leaf: function () { return leaf; },
                            script: function () { return { body: mkBuf('window.__yt=1;'), version: '1.15.2' }; }
                        });
                        proxy.listen(function (err) {
                            if (err) return clean(err);
                            var c = realNetConnect.call(net, pPort, '127.0.0.1', function () {
                                c.write(Buffer.concat([mkBuf('CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n'), clientHello]));
                            });
                            var acc = mkBuf('');
                            var timer = setTimeout(function () { c.destroy(); clean(new Error('pipelined CONNECT timed out on Node ' + process.version)); }, 2500);
                            c.on('data', function (d) {
                                acc = Buffer.concat([acc, d]);
                                var eoh = acc.indexOf('\r\n\r\n');
                                if (eoh < 0 || acc.length < eoh + 9) return;
                                clearTimeout(timer);
                                c.destroy();
                                try {
                                    assert(acc.slice(0, eoh).toString('binary').indexOf('HTTP/1.1 200') === 0, 'expected 200 Connection Established');
                                    assert(acc[eoh + 4] === 0x16 && acc[eoh + 5] === 0x03, 'expected TLS ServerHello record');
                                    var st = proxy.stats();
                                    if (nodeMajor >= 12) assert(st.opened === 1 && st.tunnels === 0, 'expected MITM on Node >= 12, got ' + JSON.stringify(st));
                                    else assert(st.tunnels === 1 && st.opened === 0, 'expected plain tunnel fallback on Node < 12, got ' + JSON.stringify(st));
                                    console.log('PASS youtube pipelined CONNECT on Node ' + process.version + ' (' + (nodeMajor >= 12 ? 'MITM' : 'tunnel fallback') + ')');
                                    clean(null);
                                } catch (ex) { clean(ex); }
                            });
                            c.on('error', function (e) { clearTimeout(timer); clean(e); });
                        });
                    });
                });
            });
        });
        capSrv.listen(0, '127.0.0.1', function () {
            var capCli = tls.connect({ host: '127.0.0.1', port: capSrv.address().port, servername: 'www.youtube.com', rejectUnauthorized: false });
            capCli.on('error', function () {});
        });
    });
} else if (process.argv[2] !== '--plugin') {
    var root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'plugins');
    fs.readdirSync(root).sort().filter(function (id) { return id[0] !== '.' && fs.statSync(path.join(root, id)).isDirectory(); }).forEach(function (id) {
        var temp = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'shard-smoke-')) : path.join(os.tmpdir(), 'shard-smoke-' + process.pid + '-' + id);
        if (!fs.existsSync(temp)) fs.mkdirSync(temp);
        var result = cp.spawnSync(process.execPath, [__filename, '--plugin', path.join(root, id), temp], {
            timeout: 5000, maxBuffer: 262144, cwd: temp,
            env: {PATH: process.env.PATH, HOME: temp, TMPDIR: temp, NODE_ENV: 'test'}, encoding: 'utf8'
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        assert(!result.error && result.status === 0, id + ': runtime smoke failed or did not release its resources (' + (result.error ? result.error.code : result.status) + ')');
    });
    var pipeRes = cp.spawnSync(process.execPath, [__filename, '--proxy-pipelined'], {
        timeout: 5000, maxBuffer: 262144, cwd: path.join(__dirname, '..'),
        env: process.env, encoding: 'utf8'
    });
    if (pipeRes.stdout) process.stdout.write(pipeRes.stdout);
    if (pipeRes.stderr) process.stderr.write(pipeRes.stderr);
    assert(!pipeRes.error && pipeRes.status === 0, 'youtube pipelined CONNECT regression check failed (' + (pipeRes.error ? pipeRes.error.code : pipeRes.status) + ')');
} else {
    var folder = path.resolve(process.argv[3]), tempDir = process.argv[4];
    var manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    if (!Buffer.from) Buffer.from = function (v, encoding) { return new Buffer(v, encoding); };
    if (!Promise.prototype.finally) Promise.prototype.finally = function (fn) { return this.then(function(v){return Promise.resolve(fn()).then(function(){return v;});},function(e){return Promise.resolve(fn()).then(function(){throw e;});}); };
    process.on('unhandledRejection', function(e){ throw e; });
    var timers = [], interval = global.setInterval, timeout = global.setTimeout;
    var clearI = global.clearInterval, clearT = global.clearTimeout;
    function remove(t) { timers = timers.filter(function(x){return x !== t;}); }
    global.setInterval = function(fn, ms) { var t = interval.apply(null, arguments); timers.push(t); return t; };
    global.clearInterval = function(t) { remove(t); clearI(t); };
    global.setTimeout = function(fn, ms) { var args = Array.prototype.slice.call(arguments, 2); var t = timeout(function(){remove(t);fn.apply(null,args);}, ms); timers.push(t); return t; };
    global.clearTimeout = function(t) { remove(t); clearT(t); };
    var config = {}, create = require(path.join(folder, manifest.main || 'index.js'));
    if (typeof create !== 'function') create = create && create.create;
    assert(typeof create === 'function', 'entry must export a plugin factory');
    function context() { return {id:manifest.id,dir:tempDir,config:{get:function(){return JSON.parse(JSON.stringify(config));},set:function(v){config=JSON.parse(JSON.stringify(v));}},execute:function(){return manifest.permissions && manifest.permissions.indexOf('exec') >= 0 ? Promise.resolve({exit_code:0,stdout:'12345.0 0.0\n',stderr:''}) : Promise.reject(Error('exec was not declared'));}}; }
    function cycle() {
        var instance = create(context()); assert(instance && typeof instance === 'object', 'factory must return an instance');
        ['start','stop','status','route'].forEach(function(k){assert(instance[k] == null || typeof instance[k] === 'function',k+' must be a function');});
        assert(!manifest.ui || typeof instance.route === 'function','UI requires route');
        return Promise.resolve().then(function(){if(instance.start)return instance.start();}).then(function(){
            if(instance.status) JSON.stringify(instance.status());
        }).then(function(){
            // A Shard with a Control center card (manifest "controlCenter") answers both methods on an empty config, quickly and without a timer.
            if(!manifest.controlCenter)return;
            assert(typeof instance.card==='function'&&typeof instance.cardSelect==='function','controlCenter needs card() and cardSelect()');
            function within(value,what){return new Promise(function(resolve,reject){var t=timeout(function(){reject(Error(what+' did not answer in 500 ms'));},500);Promise.resolve(value).then(function(v){clearT(t);resolve(v);},function(e){clearT(t);reject(e);});});}
            return within(instance.card(),'card()').then(function(c){assert(c&&typeof c==='object'&&Array.isArray(c.rows),'card() must return {rows: [...]}');JSON.stringify(c);return within(instance.cardSelect('none'),'cardSelect()');}).then(function(r){JSON.stringify(r===undefined?null:r);});
        }).then(function(){
            if(!manifest.ui)return;
            return new Promise(function(resolve,reject){
                var timer=timeout(function(){reject(Error('UI route did not answer'));},500),req=new EventEmitter(),chunks=[];
                req.method='GET';req.url='/ui';req.headers={};
                var res={statusCode:200,setHeader:function(){return this;},writeHead:function(code){this.statusCode=code;return this;},write:function(body){chunks.push(String(body));return true;},end:function(body){if(body!=null)this.write(body);clearT(timer);try{assert(this.statusCode===200,'UI must answer 200');assert(chunks.join('').length>0,'UI must return HTML');resolve();}catch(e){reject(e);}}};
                try{assert(instance.route(req,res,'ui')!==false,'UI route must be handled');process.nextTick(function(){req.emit('end');});}catch(e){clearT(timer);reject(e);}
            });
        }).then(function(){if(instance.stop)return instance.stop();}).then(function(){assert(timers.length===0,'stop() left '+timers.length+' timer(s) active');});
    }
    cycle().then(cycle).then(function(){console.log('PASS '+manifest.id+' factory/start/status/ui/stop/restart on Node '+process.version);},function(e){console.error(e.stack||e);process.exitCode=1;});
}
