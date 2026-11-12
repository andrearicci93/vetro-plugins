'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
function dashboard(){
 const dom=new JSDOM(fs.readFileSync('plugins/twitch/ui.html','utf8'),{runScripts:'outside-only'}),w=dom.window,requests=[];
 w.setInterval=()=>0;
 w.fetch=(url,options)=>new Promise(resolve=>requests.push({url,options,reply(body,code=200){resolve({ok:code<400,json:async()=>body})}}));
 w.eval(w.document.querySelector('script').textContent);
 return{w,requests,el:id=>w.document.getElementById(id),async flush(){for(let i=0;i<8;i++)await new Promise(setImmediate)},close:()=>dom.window.close()};
}
function status(adFiltering=true,emotes7tv=true,adSkipIndicator=false,playerControls=true){return{settings:{adFiltering,emotes7tv,adSkipIndicator,accountManager:false,accountChooserOnLaunch:true,playerControls},session:{phase:'ready'},filter:{attached:false},emotes:{attached:false}}}
test('dashboard disables both controls while saving and ignores older polling responses',async()=>{
 const x=dashboard();try{
  assert.equal(x.el('adFiltering').disabled,true);x.requests[0].reply(status());await x.flush();
  assert.equal(x.el('adFiltering').checked,true);assert.equal(x.el('emotes7tv').checked,true);
  x.w.poll();const stale=x.requests.at(-1);
  x.el('adFiltering').checked=false;x.el('adFiltering').dispatchEvent(new x.w.Event('change'));
  const save=x.requests.at(-1);assert.equal(save.url,'settings');assert.deepEqual(JSON.parse(save.options.body),{adFiltering:false});
  assert.equal(x.el('adFiltering').disabled,true);assert.equal(x.el('emotes7tv').disabled,true);
  save.reply({adFiltering:false,emotes7tv:true});await x.flush();stale.reply(status());await x.flush();
  assert.equal(x.el('adFiltering').checked,false);assert.equal(x.el('emotes7tv').checked,true);assert.equal(x.el('save-state').textContent,'Saved');
  x.w.poll();x.requests.at(-1).reply(status(false,true));await x.flush();assert.equal(x.el('filter').textContent,'Disabled');
 }finally{x.close()}
});
test('dashboard checks HTTP failures and reloads saved settings before allowing another change',async()=>{
 const x=dashboard();try{
  x.requests[0].reply(status());await x.flush();
  x.el('emotes7tv').checked=false;x.el('emotes7tv').dispatchEvent(new x.w.Event('change'));
  x.requests.at(-1).reply({error:'Could not save settings'},500);await x.flush();
  assert.match(x.el('save-state').textContent,/Save not confirmed: Could not save settings/);assert.equal(x.el('emotes7tv').disabled,true);
  assert.equal(x.requests.at(-1).url,'status');x.requests.at(-1).reply(status());await x.flush();
  assert.equal(x.el('emotes7tv').checked,true);assert.equal(x.el('emotes7tv').disabled,false);
  x.el('adFiltering').checked=false;x.el('adFiltering').dispatchEvent(new x.w.Event('change'));
  x.requests.at(-1).reply({adFiltering:false,emotes7tv:true});await x.flush();x.requests.at(-1).reply(status(false,true));await x.flush();
  x.el('emotes7tv').checked=false;x.el('emotes7tv').dispatchEvent(new x.w.Event('change'));
  x.requests.at(-1).reply({adFiltering:false,emotes7tv:false,playerControls:false});await x.flush();x.requests.at(-1).reply(status(false,false,false,false));await x.flush();
  assert.equal(x.el('retry').disabled,true);assert.equal(x.el('filter').textContent,'Disabled');assert.equal(x.el('emotes').textContent,'Disabled');assert.match(x.el('state').textContent,/All features disabled/);
 }finally{x.close()}
});

test('the indicator control is optional, saves independently and restores its persisted choice',async()=>{
 const x=dashboard();try{
  x.requests[0].reply(status());await x.flush();assert.equal(x.el('adSkipIndicator').checked,false);
  x.el('adSkipIndicator').checked=true;x.el('adSkipIndicator').dispatchEvent(new x.w.Event('change'));
  assert.deepEqual(JSON.parse(x.requests.at(-1).options.body),{adSkipIndicator:true});assert.equal(x.el('adSkipIndicator').disabled,true);
  x.requests.at(-1).reply({adFiltering:true,emotes7tv:true,adSkipIndicator:true});await x.flush();x.requests.at(-1).reply(status(true,true,true));await x.flush();
  assert.equal(x.el('adSkipIndicator').checked,true);assert.equal(x.el('adFiltering').checked,true);assert.equal(x.el('emotes7tv').checked,true);
 }finally{x.close()}
});

test('the live player overlay shortcut switch works independently', async () => {
    const x = dashboard();
    try {
        const on = status(false, false);
        x.requests[0].reply(on);
        await x.flush();
        assert.equal(x.el('playerControls').checked, true);
        assert.equal(x.el('retry').disabled, false);
        x.el('playerControls').checked = false;
        x.el('playerControls').dispatchEvent(new x.w.Event('change'));
        const save = x.requests.at(-1);
        assert.deepEqual(JSON.parse(save.options.body), { playerControls: false });
        const off = status(false, false, false, false);
        save.reply(off.settings);
        await x.flush();
        x.requests.at(-1).reply(off);
        await x.flush();
        assert.equal(x.el('playerControls').checked, false);
        assert.equal(x.el('retry').disabled, true);
    } finally {
        x.close();
    }
});

test('the points notification depends on automatic claims and the dashboard shows confirmed credits', async () => {
    const x = dashboard();
    try {
        const off = status(false, false);
        x.requests[0].reply(off);
        await x.flush();
        assert.equal(x.el('channelPoints').checked, false);
        assert.equal(x.el('channelPointsIndicator').disabled, true);

        x.el('channelPoints').checked = true;
        x.el('channelPoints').dispatchEvent(new x.w.Event('change'));
        assert.deepEqual(JSON.parse(x.requests.at(-1).options.body), { channelPoints: true });
        const enabled = { ...off.settings, channelPoints: true, channelPointsIndicator: false };
        x.requests.at(-1).reply(enabled);
        await x.flush();
        x.requests.at(-1).reply({ ...off, settings: enabled,
            points: { phase: 'watching', confirmed: 1, lastClaim: { channel: 'smallant', points: 50, at: 1000000 } } });
        await x.flush();
        assert.equal(x.el('channelPointsIndicator').disabled, false);
        assert.equal(x.el('retry').disabled, false);
        assert.match(x.el('points-last').textContent, /\+50 points on smallant/);

        x.el('channelPointsIndicator').checked = true;
        x.el('channelPointsIndicator').dispatchEvent(new x.w.Event('change'));
        assert.deepEqual(JSON.parse(x.requests.at(-1).options.body), { channelPointsIndicator: true });
    } finally {
        x.close();
    }
});
