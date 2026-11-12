'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const page=require('../plugins/twitch/accounts/page.js');
function setup(){
 const dom=new JSDOM('<button id="native">Native</button><div id="__next"></div>',{url:'https://pewter-example.tv.twitch.tv/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.document.getElementById('native').focus();w.eval(page.source());const api=w.__vetroTwitchAccounts;
 const model={visible:true,mode:'choose',busy:false,adding:false,canCapture:false,ack:0,profiles:[{id:'1',login:'first',active:true,state:'ready'},{id:'2',login:'second',state:'ready'}]};
 return{w,api,model,set(patch={}){Object.assign(model,patch);api.set(model)},buttons:()=>[...w.document.querySelectorAll('#vetro-twitch-accounts button')],key(code,type='keydown',extra={}){const e=new w.KeyboardEvent(type,{keyCode:code,which:code,bubbles:true,cancelable:true,...extra});w.document.dispatchEvent(e);return e},close(){if(w.__vetroTwitchAccounts)w.__vetroTwitchAccounts.stop();dom.window.close()}};
}
test('the account script only installs on the exact HTTPS Twitch TV origin', () => {
    const origin = 'https://pewter-example.tv.twitch.tv';
    for (const address of ['https://example.org/', 'http://pewter-example.tv.twitch.tv/', 'https://other.tv.twitch.tv/']) {
        const dom = new JSDOM('', { url: address, runScripts: 'outside-only' });
        try {
            dom.window.eval(page.source(origin));
            assert.equal(dom.window.__vetroTwitchAccounts, undefined);
        } finally {
            dom.window.close();
        }
    }
});
test('TV account chooser handles navigation and selection while isolating native app key handlers',()=>{
 const x=setup();try{
  let native=0;x.w.document.addEventListener('keydown',()=>native++);x.set();assert.equal(x.buttons()[0],x.w.document.activeElement);
  x.key(39);assert.equal(x.w.document.activeElement.querySelector('strong').textContent === 'second',true);assert.equal(native,0);x.key(13);let action=x.api.read().action;assert.equal(action.type,'switch');assert.equal(action.id,'2');assert.equal(x.buttons().length,0);
  x.key(13);assert.equal(x.api.read().action.sequence,action.sequence);x.set({ack:action.sequence,visible:false});assert.equal(x.api.read().action,null);assert.equal(x.w.document.activeElement.id,'native');x.key(39);assert.equal(native,1);
 }finally{x.close()}
});
test('numeric Twitch cookie IDs use the same profile identity as saved accounts', () => {
    const x = setup();
    try {
        x.w.document.cookie = 'tachyon-user=' + encodeURIComponent(JSON.stringify({ id: 42, login: 'current' })) + '; Secure';
        assert.equal(x.api.read().profile.id, '42');
    } finally {
        x.close();
    }
});
test('the account chooser follows the Twitch locale and localizes account errors', () => {
    const x = setup();
    try {
        const doc = x.w.document;
        const cases = [
            ['en-GB', 'Who’s watching?', 'Guest'], ['fr-FR', 'Qui regarde ?', 'Invité'],
            ['it-IT', 'Chi sta guardando?', 'Ospite'], ['es-MX', '¿Quién está viendo?', 'Invitado'],
            ['de-DE', 'Wer schaut zu?', 'Gast'], ['pt-BR', 'Quem está a ver?', 'Convidado'],
            ['ja-JP', 'Who’s watching?', 'Guest']
        ];
        x.set();
        for (const [locale, title, guest] of cases) {
            doc.documentElement.lang = locale;
            x.api.read();
            assert.equal(doc.querySelector('h1').textContent, title);
            assert.ok(x.buttons().some(button => button.textContent === guest));
        }
        const settings = doc.createElement('a');
        settings.href = '/settings';
        settings.setAttribute('aria-label', 'Einstellungen');
        doc.body.appendChild(settings);
        x.set({ message: 'This account needs to sign in again. Select it again to reconnect.' });
        assert.equal(doc.querySelector('h1').textContent, 'Wer schaut zu?');
        assert.match(doc.querySelector('[role="status"]').textContent, /erneut aus/);
        x.set({ mode: 'manage', message: 'Unexpected internal error' });
        assert.ok(x.buttons().some(button => button.textContent === 'first entfernen'));
        assert.equal(doc.querySelector('[role="status"]').textContent, 'Die Kontoaktion ist fehlgeschlagen. Versuche es erneut.');
    } finally {
        x.close();
    }
});
test('profile photos preserve selection and fall back to initials when an image fails', () => {
    const x = setup();
    try {
        x.set();
        x.key(39);
        const avatarUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/second-profile_image-300x300.png';
        const profiles = x.model.profiles.map(profile => profile.id === '2' ? { ...profile, avatarUrl } : profile);
        x.set({ profiles });
        const selected = x.w.document.activeElement;
        assert.equal(selected.querySelector('strong').textContent, 'second');
        const avatar = selected.querySelector('.vt-avatar');
        const picture = avatar.querySelector('img');
        assert.equal(picture.src, avatarUrl);
        assert.equal(picture.referrerPolicy, 'no-referrer');
        assert.equal(picture.style.visibility, 'hidden');
        picture.dispatchEvent(new x.w.Event('load'));
        assert.equal(picture.style.visibility, '');
        picture.dispatchEvent(new x.w.Event('error'));
        assert.equal(avatar.querySelector('img'), null);
        assert.equal(avatar.textContent, 'SE');
    } finally {
        x.close();
    }
});
test('Back dismisses the chooser, Home passes through, and forgetting requires an explicit confirmation',()=>{
 const x=setup();try{
  x.set({mode:'manage'});assert.equal(x.key(36).defaultPrevented,false);
  x.buttons().find(b=>b.textContent==='Forget first').click();assert.match(x.w.document.querySelector('h1').textContent,/Forget/);assert.equal(x.api.read().action,null);
  x.key(10009);assert.equal(x.api.read().action,null);assert.equal(x.w.document.querySelector('h1').textContent,'Manage accounts');
  x.buttons().find(b=>b.textContent==='Forget first').click();x.buttons()[1].click();assert.equal(x.api.read().action.type,'forget');assert.equal(x.api.read().action.id,'1');
  x.set({ack:x.api.read().action.sequence});x.key(10009);assert.equal(x.api.read().action.type,'choose');
 }finally{x.close()}
});
test('adding exposes a cancel action without replacing the native Twitch login screen',()=>{
 const x=setup();try{x.set({mode:'manage',adding:true});assert.deepEqual(x.buttons().map(b=>b.textContent),['Continue signing in','Cancel sign-in']);x.buttons()[1].click();assert.equal(x.api.read().action.type,'cancel')}finally{x.close()}
});
test('page output never exposes cookie values; account names render as text and cleanup removes listeners and DOM',()=>{
 const x=setup();try{
  x.w.document.cookie='auth-token=private-browser-token; Secure; SameSite=None';x.w.document.cookie='tachyon-user='+encodeURIComponent(JSON.stringify({id:'1',login:'first'}))+'; Secure';
  x.set({profiles:[{id:'1',login:'<img src=x onerror=alert(1)>',state:'ready'}]});assert.equal(x.w.document.querySelectorAll('#vetro-twitch-accounts img').length,0);
  const value=x.api.read();assert.equal(value.tokenPresent,true);assert.equal(value.profile.id,'1');assert.ok(!JSON.stringify(value).includes('private-browser-token'));
  x.w.eval(page.source());assert.equal(x.w.__vetroTwitchAccounts,x.api);x.api.stop();assert.equal(x.w.document.getElementById('vetro-twitch-accounts'),null);assert.equal(x.w.__vetroTwitchAccounts,undefined);assert.equal(x.key(39).defaultPrevented,false);
 }finally{x.close()}
});
test('app authentication verification reads its React provider rather than treating cookies alone as a signed-in UI',()=>{
 const x=setup();try{
  const node=x.w.document.getElementById('__next');node.__reactContainer$fixture={memoizedProps:{value:{authCookieName:'auth-token',loggedIn:false,logout(){},authToken:'must-not-leak'}}};
  assert.equal(x.api.read(true).auth,false);node.__reactContainer$fixture.memoizedProps.value.loggedIn=true;assert.equal(x.api.read(true).auth,true);assert.ok(!JSON.stringify(x.api.read(true)).includes('must-not-leak'));
 }finally{x.close()}
});

test('Back on the owned native sign-in screen cancels adding; ordinary native Back is preserved',()=>{
 const x=setup();try{
  x.w.history.replaceState(null,'','/login');x.set({visible:false,adding:true});assert.match(x.w.document.body.textContent,/Back to cancel/);
  assert.equal(x.key(10009).defaultPrevented,true);assert.equal(x.api.read().action.type,'cancel');assert.equal(x.key(10009,'keyup').defaultPrevented,true);
  x.set({adding:false,ack:x.api.read().action.sequence});assert.equal(x.key(10009).defaultPrevented,false);assert.ok(!x.w.document.body.textContent.includes('Back to cancel'));
 }finally{x.close()}
});

test('the native login Back button cancels the same account change by click or remote OK', () => {
    const x = setup();
    try {
        x.w.document.documentElement.lang = 'fr';
        x.w.history.replaceState(null, '', '/login');
        const nativeBack = x.w.document.createElement('button');
        nativeBack.setAttribute('aria-label', 'Revenir en arrière');
        nativeBack.appendChild(x.w.document.createElement('span'));
        x.w.document.body.appendChild(nativeBack);
        let nativeClicks = 0;
        nativeBack.onclick = () => { nativeClicks++; };

        x.set({ visible: false, adding: true });
        assert.equal(x.w.document.querySelector('[role="status"]'), null);
        nativeBack.firstElementChild.click();
        assert.equal(nativeClicks, 0);
        assert.equal(x.api.read().action.type, 'cancel');

        x.set({ ack: x.api.read().action.sequence });
        nativeBack.focus();
        assert.equal(x.key(13).defaultPrevented, true);
        assert.equal(x.api.read().action.type, 'cancel');
        x.set({ adding: false, ack: x.api.read().action.sequence });
        assert.equal(x.key(13, 'keyup').defaultPrevented, true);
        nativeBack.click();
        assert.equal(nativeClicks, 1);
        assert.equal(x.key(13).defaultPrevented, false);
    } finally {
        x.close();
    }
});

test('the Portuguese native login button cancels adding without a duplicate hint', () => {
    const x = setup();
    try {
        x.w.document.documentElement.lang = 'pt-PT';
        x.w.history.replaceState(null, '', '/login');
        const back = x.w.document.createElement('button');
        back.textContent = 'Voltar atrás';
        x.w.document.body.appendChild(back);
        x.set({ visible: false, adding: true });
        assert.equal(x.w.document.querySelector('[role="status"]'), null);
        back.click();
        assert.equal(x.api.read().action.type, 'cancel');
        assert.equal(x.w.document.querySelector('[role="status"]').textContent, 'A cancelar o início de sessão…');
    } finally {
        x.close();
    }
});

test('Guest is a selectable profile and receives focus when already active', () => {
    const x = setup();
    try {
        const signedOutProfiles = x.model.profiles.map(profile => ({ ...profile, active: false }));
        x.set({ profiles: signedOutProfiles, guest: true });
        assert.equal(x.w.document.activeElement.querySelector('strong').textContent, 'Guest');
        assert.match(x.w.document.activeElement.textContent, /Current session/);
        x.key(13);
        assert.equal(x.api.read().action.type, 'guest');
        assert.equal(x.api.read().action.id, null);
    } finally {
        x.close();
    }
});

test('home Accounts entry joins the native Settings row without changing its activation', () => {
    const x = setup();
    try {
        const wrapper = x.w.document.createElement('div');
        const settings = x.w.document.createElement('a');
        settings.href = '/settings';
        settings.setAttribute('aria-label', 'Settings');
        const nativeStyle = x.w.document.createElement('style');
        nativeStyle.textContent = 'a[href="/settings"] { box-shadow: 0 0 0 4px white; }';
        x.w.document.head.appendChild(nativeStyle);
        wrapper.appendChild(settings);
        x.w.document.body.appendChild(wrapper);
        x.set({ visible: false });
        const entry = settings.nextElementSibling;
        assert.equal(entry.textContent, 'Accounts');
        settings.focus();
        let nativeEnter = 0;
        x.w.document.addEventListener('keydown', (event) => {
            if (event.keyCode === 13) nativeEnter++;
        });
        x.key(13);
        assert.equal(nativeEnter, 1);
        assert.equal(x.key(39).defaultPrevented, true);
        x.key(39, 'keyup');
        assert.equal(x.w.document.activeElement, entry);
        assert.equal(x.w.getComputedStyle(settings).boxShadow, 'none');
        x.set({ homeAccount: { login: 'second' } });
        assert.equal(settings.nextElementSibling, entry);
        assert.equal(x.w.document.activeElement, entry);
        assert.equal(entry.getAttribute('aria-label'), 'Switch account · second');
        assert.equal(entry.querySelector('.vt-entry-name').textContent, 'second');
        assert.equal(entry.querySelector('.vt-entry-initials').textContent, 'SE');
        const avatarUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/second-profile_image-300x300.png';
        x.set({ homeAccount: { login: 'second', avatarUrl } });
        assert.equal(entry.querySelector('img').src, avatarUrl);
        entry.querySelector('img').dispatchEvent(new x.w.Event('error'));
        assert.equal(entry.querySelector('img'), null);
        assert.equal(entry.querySelector('.vt-entry-initials').textContent, 'SE');
        x.set({ homeAccount: { guest: true } });
        assert.equal(entry.getAttribute('aria-label'), 'Switch account · Guest');
        assert.equal(entry.querySelector('.vt-entry-name').textContent, 'Guest');
        assert.equal(x.w.document.activeElement, entry);
        x.key(37);
        x.key(37, 'keyup');
        assert.equal(x.w.document.activeElement, settings);
        assert.equal(x.w.getComputedStyle(settings).boxShadow, '0 0 0 4px white');
        x.key(39);
        x.key(39, 'keyup');
        x.key(13);
        assert.equal(x.api.read().action.type, 'choose');
        assert.equal(nativeEnter, 1);
        x.set({ visible: true, ack: 1 });
        assert.ok(x.buttons().some((button) => button.textContent === 'Manage accounts'));
        assert.ok(!x.buttons().some((button) => button.textContent.startsWith('Forget')));
        x.set({ visible: false, ack: 1 });
        assert.equal(x.w.document.activeElement, entry);
        x.w.history.pushState(null, '', '/settings');
        x.api.read();
        assert.equal(settings.nextElementSibling, null);
        assert.equal(settings.getAttribute('href'), '/settings');
        assert.equal(settings.hasAttribute('data-vetro-accounts-focused'), false);
    } finally {
        x.close();
    }
});
