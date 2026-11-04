'use strict';
// ES5 so the same lifecycle harness actually runs under Node 4.4 and newer TVs.
var fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
var EventEmitter = require('events').EventEmitter;
function fail(message) { throw new Error(message); }
function assert(value, message) { if (!value) fail(message); }
if (process.argv[2] !== '--plugin') {
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
