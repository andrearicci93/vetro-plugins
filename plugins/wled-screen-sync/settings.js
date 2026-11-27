'use strict';
var fs = require('fs'), path = require('path'), request = require('./controller');
var fields = require('./controls.json'), isPrivateIpv4 = require('./target');
function valid(f, v) {
    if (f.type === 'toggle') return typeof v === 'boolean';
    if (f.type === 'color') return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (f.options) return typeof v === 'string' && Object.prototype.hasOwnProperty.call(f.options,v);
    if (f.type === 'ipv4') return typeof v === 'string' && /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);
    if (f.choices) return f.choices.indexOf(v) >= 0;
    return typeof v === 'number' && v === Math.floor(v) && v >= f.min && v <= f.max;
}
function readBody(req, limit, res, onBody, onTooLarge) {
    var chunks = [], size = 0, done = false;
    req.on('error', function() { done = true; });
    req.on('data', function(chunk) {
        if (done) return;
        var buf = Buffer.isBuffer(chunk) ? chunk : new Buffer(String(chunk), 'utf8');
        size += buf.length;
        if (size > limit) {
            done = true;
            onTooLarge();
            if (typeof req.destroy === 'function') req.destroy();
            return;
        }
        chunks.push(buf);
    });
    req.on('end', function() {
        if (done) return;
        done = true;
        onBody(Buffer.concat(chunks).toString('utf8'));
    });
}
module.exports = function(ctx, status, onModeChange) {
    function adjustCounts(values, total) {
        var ends=[0,172,269,441,538];
        values.Leds=total;
        ['Top','Right','Bottom','Left'].forEach(function(side,i){
            values[side+'Count']=Math.round(total*ends[i+1]/538)-Math.round(total*ends[i]/538);
        });
    }
    function load() {
        var old = ctx.config.get() || {}, values = {};
        fields.forEach(function(f){ values[f.key] = valid(f,old[f.key]) ? old[f.key] : f.default; });
        var effectKey={impact:'ImpactEffect',balanced:'BalancedEffect',music:'MusicEffect'}[values.AudioSampling];
        if(effectKey && old[effectKey]===undefined && old.AudioReaction===values.AudioReaction)values[effectKey]=values.AudioReaction;
        if (old.TopCount === undefined) adjustCounts(values,values.Leds);
        return values;
    }
    var discovery, current=load(), stopped=false, queue=Promise.resolve();
    var savedWledStates=(ctx.config.get()||{}).savedWledStates || {};
    function persist(values){
        var data={};
        Object.keys(values).forEach(function(k){data[k]=values[k];});
        data.savedWledStates=savedWledStates;
        ctx.config.set(data);
    }
    function serial(task){
        var work=queue.then(task);
        queue=work.catch(function(){});
        return work;
    }
    function wledRequest(address,endpoint,patch){
        return new Promise(function(resolve,reject){
            if(!isPrivateIpv4(address))return reject(Error('Enter a private IPv4 address for WLED'));
            request(address,endpoint,4000,patch===null?null:JSON.stringify(patch),function(error,code,body){
                if(error || code<200 || code>=300)return reject(error||Error('WLED HTTP '+code));
                try {resolve(JSON.parse(body));}catch(e){reject(e);}
            });
        });
    }
    function readInfo(address){
        return wledRequest(address,'/json/info',null).then(function(info){
            var count=info && info.leds && info.leds.count;
            if(!info || info.brand!=='WLED' || typeof info.ver!=='string' || !info.ver ||
                typeof count!=='number' || count!==Math.floor(count) || !isFinite(count) || count<1)
                throw Error('Invalid WLED response');
            return info;
        });
    }
    function writePower(address,on){
        return wledRequest(address,'/json/state',{on:on}).then(function(result){
            if(!result || result.success!==true)throw Error('WLED did not accept the power change');
        });
    }
    function restoreWled(address){
        var snapshot=savedWledStates[address];
        if(!isPrivateIpv4(address) || !snapshot || typeof snapshot.on!=='boolean')return Promise.resolve();
        return readInfo(address).then(function(){return writePower(address,snapshot.on);}).then(function(){
            delete savedWledStates[address];
            try {persist(current);}catch(e){savedWledStates[address]=snapshot;throw e;}
        });
    }
    function enterWled(address){
        if(!isPrivateIpv4(address))return Promise.resolve();
        return readInfo(address).then(function(info){
            return wledRequest(address,'/json/state',null).then(function(state){
                if(!state || typeof state.on!=='boolean')throw Error('Invalid WLED power state');
                if(state.on)return info;
                if(!Object.prototype.hasOwnProperty.call(savedWledStates,address)){
                    savedWledStates[address]={on:false};
                    try {persist(current);}catch(e){delete savedWledStates[address];throw e;}
                }
                return writePower(address,true).then(function(){return info;});
            });
        });
    }
    function json(res,value,code) {
        res.writeHead(code || 200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(value));
    }
    var route=function(req,res,sub) {
        if (sub === 'ui' && req.method === 'GET') {
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
            res.end(fs.readFileSync(path.join(__dirname,'panel.html')));return true;
        }
        if (sub === 'settings' && req.method === 'GET') {
            json(res,{fields:fields,values:load()});return true;
        }
        if (sub === 'discover' && req.method === 'POST') {
            if (!discovery) discovery = require('./discover')().then(function(devices) {
                discovery = null;
                return devices;
            }, function(error) { discovery = null; throw error; });
            discovery.then(function(devices) { json(res,{devices:devices}); },
                function(error) { json(res,{error:error.message},503); });
            return true;
        }
        if (sub === 'preview' && req.method === 'GET') {
            try {
                var liveState = status ? status() : null;
                if (liveState && ['stopping','stopped','stop-failed','waiting','failed'].indexOf(liveState.state)>=0) {
                    json(res,{rgb:''});return true;
                }
                var preview=path.join(ctx.dir,'runtime','preview.b64');
                var rgb='';
                if (fs.existsSync(preview)) {
                    var st = fs.statSync(preview);
                    if (Date.now() - st.mtime.getTime() <= 3000) rgb = fs.readFileSync(preview,'utf8').trim();
                }
                json(res,{rgb:/^[A-Za-z0-9+/]{192}$/.test(rgb) ? rgb : ''});
            } catch(e){json(res,{error:'Preview unavailable'},503);}
            return true;
        }
        if (sub === 'live' && req.method === 'GET') { json(res,status());return true; }
        if (sub === 'wled-probe' && req.method === 'POST') {
            readBody(req, 4096, res, function(probeBody) {
                try {
                    var address=JSON.parse(probeBody).address;
                    readInfo(address).then(function(info){
                        json(res,{address:address,name:typeof info.name==='string'?info.name:'WLED',leds:info.leds.count,version:info.ver});
                    },function(error){json(res,{error:error.message},400);});
                } catch(error) { json(res,{error:error.message},400); }
            }, function() { json(res,{error:'Probe payload too large'},413); });
            return true;
        }
        if (sub !== 'settings' || req.method !== 'POST') return false;
        readBody(req, 4096, res, function(body) {
            serial(function(){
                if(stopped)throw Error('Shard stopped');
                var patch=JSON.parse(body);
                if (!patch || Array.isArray(patch) || typeof patch!=='object')throw Error('Invalid settings');
                var next=load(), previous=current;
                Object.keys(patch).forEach(function(k){
                    var field=fields.filter(function(item){return item.key===k;})[0];
                    if(!field || !valid(field,patch[k]))throw Error('Invalid setting: '+k);
                    next[k]=patch[k];
                });
                if(next.Wled!=='127.0.0.1' && !isPrivateIpv4(next.Wled))throw Error('Enter a private IPv4 address for WLED');
                next.Leds=next.TopCount+next.RightCount+next.BottomCount+next.LeftCount;
                if(next.Leds<1 || next.Leds>4096)throw Error('The four sides must total 1 to 4096 LEDs.');
                var explicitCounts=['TopCount','RightCount','BottomCount','LeftCount'].some(function(k){
                    return Object.prototype.hasOwnProperty.call(patch,k);
                });
                var switching=next.Wled!==previous.Wled;
                return (switching?enterWled(next.Wled):Promise.resolve()).then(function(info){
                    if(stopped)throw Error('Shard stopped');
                    if(info && !explicitCounts && info.leds.count<=4096)adjustCounts(next,info.leds.count);
                    persist(next);
                    current=next;
                }).catch(function(error){
                    if(!switching)throw error;
                    // A timed-out write may have reached the replacement. Its saved power state stays durable.
                    return restoreWled(next.Wled).catch(function(){}).then(function(){throw error;});
                }).then(function(){
                    if(onModeChange)return onModeChange(next,previous);
                }).then(function(){
                    // Let the configured output switch before restoring the previous controller.
                    if(switching)return restoreWled(previous.Wled).catch(function(){});
                }).then(function(){
                    json(res,{values:next});
                });
            }).catch(function(error){json(res,{error:error.message},400);});
        }, function() { json(res,{error:'Settings payload too large'},413); });
        return true;
    };
    route.start=function(){
        stopped=false;
        return serial(function(){
            persist(current);
            return Object.keys(savedWledStates).reduce(function(chain,address){
                return address===current.Wled?chain:chain.then(function(){return restoreWled(address).catch(function(){});});
            },Promise.resolve()).then(function(){if(!stopped)return enterWled(current.Wled);});
        });
    };
    route.pause=function(){stopped=true;};
    route.stop=function(){
        stopped=true;
        return serial(function(){return restoreWled(current.Wled);});
    };
    return route;
};
