'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../plugins/twitch/filter/playlist-filter.js');
const inspector = require('../plugins/twitch/inspector-client.js');
const MASTER = 'https://usher.ttvnw.net/api/channel/hls/example.m3u8?token=original&allow_source=true';
const MASTER_V2 = MASTER.replace('/api/channel/', '/api/v2/channel/');
const MEDIA = 'https://video-weaver.example.ttvnw.net/live/main.m3u8';
const BACKUP = 'https://video-weaver.example.ttvnw.net/backup/index.m3u8';
const SECOND_BACKUP = 'https://video-weaver.example.ttvnw.net/second/index.m3u8';
const manifest = url => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080,FRAME-RATE=60\n' + url;
const avcMaster = url => manifest(url).replace('FRAME-RATE=60', 'FRAME-RATE=60,CODECS="avc1.64002A,mp4a.40.2"');
const avcVariants = (...urls) => '#EXTM3U\n' + urls.map(url => avcMaster(url).split('\n').slice(1).join('\n')).join('\n');
const clean = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PROGRAM-DATE-TIME:2026-11-07T00:00:00.000Z\n#EXTINF:2,\nsegment.ts\n';
const advert = clean + '#EXT-X-DATERANGE:ID="ad",CLASS="twitch-stitched-ad",START-DATE="2026-11-07T00:00:00Z"\n';
function fixture(opts = {}) {
    const calls = [];
    const original = async function(address, options) {
        calls.push({ address, options });
        let text;
        if (address === MASTER || address === MASTER_V2) text = opts.wrongCodec || opts.splice ? avcMaster(MEDIA) : manifest(MEDIA);
        else if (address === MEDIA) text = opts.preroll ? opts.main || advert : clean;
        else if (address === 'https://gql.twitch.tv/gql') {
            assert.equal(options.headers.Authorization, undefined);
            const variables = JSON.parse(options.body).variables;
            assert.equal(variables.login, 'example');
            if (opts.fail) throw new Error('offline');
            const value = opts.masters ? variables.playerType : 'alternate';
            text = JSON.stringify({data:{streamPlaybackAccessToken:{value,signature:'signature'}}});
        } else if (address.startsWith('https://usher.ttvnw.net/')) {
            text = opts.masters ? opts.masters[new URL(address).searchParams.get('token')] : opts.splice ? avcMaster(BACKUP) : manifest(BACKUP);
            if (opts.wrongQuality) text = text.replace('1920x1080', '640x360');
            if (opts.wrongCodec) text = avcMaster(BACKUP).replace('avc1.64002A', 'hev1.1.6.L123');
        }
        else if (opts.playlists && Object.hasOwn(opts.playlists, address)) text = opts.playlists[address];
        else if (address === BACKUP) {
            if (opts.backupReady) await opts.backupReady;
            text = opts.backupAds ? advert : opts.backup || clean;
        }
        else text = 'unchanged';
        return text;
    };
    const processor = engine.create(original, () => opts.adFallback === true);
    const intercept = async address => processor.replacementFor(address, address === MEDIA ? opts.main || advert : await original(address));
    return { processor, intercept, calls, requestText: original };
}
function liveWindow(sequence, first, count, { source = 'native', ad = false, init = null, clockOffset = 0, liveBase = 10000 } = {}) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:' + sequence,
        '#EXT-X-TWITCH-LIVE-SEQUENCE:' + (liveBase + first)];
    if (ad) lines.push('#EXT-X-DATERANGE:ID="stitched-ad-break",CLASS="twitch-stitched-ad"');
    if (init) lines.push('#EXT-X-MAP:URI="' + init + '"');
    for (let i = first; i < first + count; i++) {
        const time = new Date(Date.UTC(2026, 10, 24) + i * 2000 + clockOffset).toISOString();
        lines.push('#EXT-X-PROGRAM-DATE-TIME:' + time, '#EXTINF:2,' + (ad ? 'ad' : 'live'), source + '-' + i + '.ts');
    }
    return lines.join('\n') + '\n';
}
test('clean live media is unchanged and needs no auxiliary request', async () => {
    const f = fixture({main:clean}); await f.intercept(MASTER); const r = await f.intercept(MEDIA);
    assert.equal(r, null); assert.equal(f.calls.length, 2); f.processor.stop();
});
test('a preroll can switch rendition URLs before the player adopts the media timeline', async () => {
    const f = fixture({ preroll: true, backup: clean.replace('SEQUENCE:100', 'SEQUENCE:4326') });
    const replacement = await f.intercept(MASTER);
    assert.match(replacement, /backup\/index\.m3u8/);
    assert.equal(f.processor.stats.prerollsDetected, 1);
    assert.equal(f.processor.stats.prerollsReplaced, 1);
    assert.equal(f.processor.stats.timelineMismatches, 0);
    f.processor.stop();
});
test('a preroll leaves the original master when clean alternatives would drop a rendition', async () => {
    const f = fixture({ preroll: true });
    const master = manifest(MEDIA) + '\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=2560x1440,FRAME-RATE=60\n' +
        new URL('1440p.m3u8', MEDIA).href;
    assert.equal(await f.processor.replacementFor(MASTER, master), null);
    assert.equal(f.processor.stats.prerollsDetected, 1);
    assert.equal(f.processor.stats.prerollsReplaced, 0);
    f.processor.stop();
});
test('a master refresh cannot replace the timeline after media playback has started', async () => {
    const f = fixture({ preroll: true, backup: clean.replace('SEQUENCE:100', 'SEQUENCE:4326') });
    try {
        const master = await f.intercept(MASTER);
        const alternateMaster = f.calls.find(call => call.address.startsWith('https://usher.ttvnw.net/') && call.address !== MASTER).address;
        await f.processor.replacementFor(BACKUP, clean.replace('SEQUENCE:100', 'SEQUENCE:4326'));
        const requests = f.calls.length;
        assert.equal(await f.processor.replacementFor(MASTER, manifest(MEDIA)), null);
        assert.equal(await f.processor.replacementFor(alternateMaster, master), null);
        assert.equal(f.calls.length, requests);
        assert.equal(f.processor.stats.prerollsReplaced, 1);
    } finally {
        f.processor.stop();
    }
});
test('a pending preroll search stops replacing the master if a media response arrives first', async () => {
    let release, ready;
    const pending = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { ready = resolve; });
    const f = fixture({ preroll: true });
    const processor = engine.create(async (address, options) => {
        const text = await f.requestText(address, options);
        if (address === BACKUP) { ready(); await pending; }
        return text;
    });
    try {
        const replacement = processor.replacementFor(MASTER, manifest(MEDIA));
        await requested;
        assert.equal(await processor.replacementFor(MEDIA, clean), null);
        release();
        assert.equal(await replacement, null);
        assert.equal(processor.stats.prerollsReplaced, 0);
    } finally {
        release();
        processor.stop();
        f.processor.stop();
    }
});
test('marked ads use matching clean backup with absolute segment/key/map URIs', async () => {
    const f = fixture(); await f.intercept(MASTER); const body = await f.intercept(MEDIA);
    assert.match(body,/https:\/\/video-weaver.example.ttvnw.net\/backup\/segment.ts/);
    assert.match(body,/URI="https:\/\/video-weaver.example.ttvnw.net\/backup\/key.bin"/);
    assert.match(body,/URI="https:\/\/video-weaver.example.ttvnw.net\/backup\/init.mp4"/);
    assert.equal(f.processor.stats.replacements,1);
    const alternateMaster = new URL(f.calls.find(call => call.address.startsWith('https://usher.ttvnw.net/') && call.address !== MASTER).address);
    assert.equal(alternateMaster.searchParams.get('token'), 'alternate');
    assert.equal(alternateMaster.searchParams.get('sig'), 'signature');
    assert.equal(alternateMaster.searchParams.get('allow_source'), 'true');
    const tokens = f.calls.filter(c => c.address.endsWith('/gql')).length;
    await f.intercept(MEDIA); assert.equal(f.calls.filter(c => c.address.endsWith('/gql')).length,tokens);
    f.processor.stop();
});
test('v2 masters ignore HLS delivery directives while preserving signed rendition parameters', async () => {
    const f = fixture();
    const signed = MEDIA + '?sig=main';
    await f.processor.replacementFor(MASTER_V2, manifest(signed));
    assert.equal(await f.processor.replacementFor(MEDIA + '?sig=other&_HLS_msn=100', advert), null);
    const replacement = await f.processor.replacementFor(signed + '&_HLS_msn=100&_HLS_part=1&_HLS_skip=YES', advert);
    assert.match(replacement, /backup\/segment\.ts/);
    assert.equal(f.processor.stats.ads, 2);
    assert.equal(f.processor.stats.unmappedAds, 1);
    const alternate = f.calls.find(call => new URL(call.address).searchParams.get('token') === 'alternate');
    assert.equal(new URL(alternate.address).pathname, '/api/v2/channel/hls/example.m3u8');
    f.processor.stop();
});
test('Twitch ad IDs and ad attributes are recognized in both the original and the backup', async () => {
    const marked = [
        clean + '#EXT-X-DATERANGE:ID="stitched-ad-42",START-DATE="2026-11-07T00:00:00Z"\n',
        clean + '#EXT-X-DATERANGE:ID="42",X-TV-TWITCH-AD-POD-LENGTH="30"\n',
        clean + '#EXT-X-CUE-OUT-CONT:ElapsedTime=2,Duration=30\n'
    ];
    for (const playlist of marked) {
        const detected = fixture({ main: playlist, preroll: true });
        assert.match(await detected.processor.replacementFor(MASTER, manifest(MEDIA)), /backup\/index\.m3u8/);
        assert.match(await detected.intercept(MEDIA), /backup\/segment\.ts/);
        const rejected = fixture({ backup: playlist });
        await rejected.intercept(MASTER);
        assert.equal(await rejected.intercept(MEDIA), null);
        assert.equal(rejected.processor.stats.replacements, 0);
        detected.processor.stop();
        rejected.processor.stop();
    }
});
test('live sequence and matching timestamps permit rebasing only a complete unencrypted window', async () => {
    const liveSequence = '#EXT-X-TWITCH-LIVE-SEQUENCE:4326\n';
    const main = advert.replace(/^#EXT-X-KEY:.*\n/m, '') + liveSequence;
    const backup = clean.replace(/^#EXT-X-KEY:.*\n/m, '').replace('MEDIA-SEQUENCE:100', 'MEDIA-SEQUENCE:4326') + liveSequence;
    const f = fixture({ main, backup });
    await f.intercept(MASTER);
    const result = await f.intercept(MEDIA);
    assert.match(result, /^#EXT-X-MEDIA-SEQUENCE:100$/m);
    assert.match(result, /backup\/segment\.ts/);
    assert.equal(f.processor.stats.rebased, 1);
    f.processor.stop();
    for (const [alternative, reason] of [
        [backup.replace('LIVE-SEQUENCE:4326', 'LIVE-SEQUENCE:4327'), 'mediaSequence'],
        [backup.replace('00:00:00.000Z', '00:00:10.000Z'), 'timestamp'],
        [backup.replace(/^#EXT-X-PROGRAM-DATE-TIME:.*\n/m, ''), 'missingAnchor'],
        [backup + '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n', 'unsupportedPlaylist'],
        [backup + '#EXT-X-SKIP:SKIPPED-SEGMENTS=2\n', 'unsupportedPlaylist'],
        [backup + '#EXT-X-RENDITION-REPORT:URI="other.m3u8",LAST-MSN=4326\n', 'unsupportedPlaylist']
    ]) {
        const refused = fixture({ main, backup: alternative });
        await refused.intercept(MASTER);
        assert.equal(await refused.intercept(MEDIA), null);
        assert.equal(refused.processor.stats.timelineRejections[reason], 1);
        refused.processor.stop();
    }
});
test('a short clean window fills only new sequences of a long ad playlist and preserves them on return', async () => {
    const opts = { splice: true, backup: liveWindow(9000, 39, 16, { source: 'backup', init: 'alt-init.mp4' }) };
    const f = fixture(opts);
    const present = (body, register) => f.processor.replacementFor(MEDIA, body, register);
    const native = { init: 'native-init.mp4' };
    // Stitched ads can use a different clock. The clean live tail provides the actual overlap.
    const ad = { source: 'ad', ad: true, init: 'ad-init.mp4', clockOffset: 350 };
    await f.intercept(MASTER);
    await present(liveWindow(138, 38, 16, native));

    let first = await present(liveWindow(100, 0, 55, ad));
    assert.match(first, /^#EXT-X-MEDIA-SEQUENCE:138$/m);
    assert.match(first, /^#EXT-X-TWITCH-LIVE-SEQUENCE:10038$/m);
    assert.match(first, /native-53\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="[^"]+alt-init\.mp4"/);
    assert.match(first, /backup-54\.ts/);
    assert.doesNotMatch(first, /backup-53\.ts|ad-54\.ts|stitched-ad/);

    opts.backup = liveWindow(9001, 40, 16, { source: 'backup', init: 'alt-init.mp4' });
    const second = await present(liveWindow(100, 0, 56, ad));
    assert.equal((second.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1);
    assert.match(second, /backup-54\.ts[\s\S]+backup-55\.ts/);
    assert.equal(f.processor.stats.spliced, 2);
    assert.equal(f.processor.stats.timelineMismatches, 0);

    const cleanNative = liveWindow(142, 42, 16, native);
    const returned = await present(cleanNative);
    assert.match(returned, /backup-55\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="[^"]+native-init\.mp4"/);
    assert.match(returned, /native-56\.ts[\s\S]+native-57\.ts/);
    assert.doesNotMatch(returned, /native-54\.ts|native-55\.ts/);
    assert.equal(await present(cleanNative), returned, 'a repeated refresh keeps the same URLs');
    f.processor.stop();
});
test('Twitch live sequences calibrate the observed 235 ms clock skew without changing the player timeline', async () => {
    const liveBase = 3555;
    const backup = { liveBase, source: 'backup', clockOffset: -235 };
    const opts = { splice: true, backup: liveWindow(3557, 2, 15, backup) };
    const f = fixture(opts);
    const ad = { liveBase, source: 'slate', ad: true, clockOffset: 350 };
    await f.intercept(MASTER);
    await f.processor.replacementFor(MEDIA, liveWindow(3556, 0, 16, { liveBase }));
    const first = await f.processor.replacementFor(MEDIA, liveWindow(3518, -38, 55, ad));
    assert.match(first, /native-15\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-11-24T00:00:32\.000Z\n#EXTINF:2,live\n[^\n]*backup-16\.ts/);
    assert.match(first, /^#EXT-X-MEDIA-SEQUENCE:3556$/m);
    assert.doesNotMatch(first, /slate-16\.ts|backup-15\.ts/);

    opts.backup = liveWindow(3558, 3, 15, backup);
    const second = await f.processor.replacementFor(MEDIA, liveWindow(3518, -38, 56, ad));
    assert.match(second, /backup-16\.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-11-24T00:00:34\.000Z\n#EXTINF:2,live\n[^\n]*backup-17\.ts/);
    const returned = await f.processor.replacementFor(MEDIA, liveWindow(3559, 3, 16, { liveBase }));
    assert.match(returned, /backup-17\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-11-24T00:00:36\.000Z\n#EXTINF:2,live\n[^\n]*native-18\.ts/);
    assert.equal(f.processor.stats.spliced, 2);
    f.processor.stop();
});
test('experimental fallback uses a short clean window and keeps sent segments through the return to native', async () => {
    const opts = { splice: true, adFallback: true, backup: liveWindow(9000, 39, 16, { source: 'backup' }) };
    const f = fixture(opts);
    const present = (body, register) => f.processor.replacementFor(MEDIA, body, register);
    const slate = { source: 'slate', ad: true, clockOffset: 350 };
    await f.intercept(MASTER);
    await present(liveWindow(138, 38, 16));

    let finish;
    const first = await present(liveWindow(100, 0, 58, slate), commit => { finish = commit; return true; });
    assert.match(first, /^#EXT-X-MEDIA-SEQUENCE:138$/m);
    assert.match(first, /native-53\.ts\n#EXT-X-DISCONTINUITY\n[^\n]+\n#EXTINF:2,live\n[^\n]+backup-54\.ts/);
    assert.doesNotMatch(first, /backup-53\.ts|slate-|stitched-ad/);
    assert.equal(f.processor.stats.spliceRejections.coverage, 1);
    assert.equal(f.processor.stats.fallbacks, 0);
    finish(true);
    assert.equal(f.processor.stats.fallbacks, 1);
    assert.equal(await present(liveWindow(100, 0, 58, slate)), first);

    opts.backup = liveWindow(9002, 41, 16, { source: 'backup' });
    const next = await present(liveWindow(100, 0, 59, slate));
    assert.match(next, /backup-54\.ts[\s\S]+backup-55\.ts[\s\S]+backup-56\.ts/);
    assert.equal((next.match(/^#EXT-X-DISCONTINUITY$/gm) || []).length, 1);

    const cleanNative = liveWindow(144, 44, 16);
    const returned = await present(cleanNative);
    assert.match(returned, /backup-56\.ts\n#EXT-X-DISCONTINUITY\n[^\n]+\n#EXTINF:2,live\n[^\n]+native-57\.ts/);
    assert.doesNotMatch(returned, /native-56\.ts/);
    assert.equal(await present(cleanNative), returned);
    assert.equal(f.processor.stats.fallbacks, 3);
    assert.equal(f.calls.filter(call => call.address === 'https://gql.twitch.tv/gql').length, 2);
    f.processor.stop();
});
test('experimental fallback can join without a time anchor and still requires a compatible clear feed', async () => {
    const mismatched = liveWindow(9000, 40, 16, { source: 'backup', clockOffset: 650, liveBase: 11000 });
    for (const opts of [{}, { wrongCodec: true }, { backupAds: true }, { backup: mismatched.replace('#EXT-X-VERSION:7',
        '#EXT-X-VERSION:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"') }]) {
        const f = fixture({ splice: true, adFallback: true, backup: mismatched, ...opts });
        await f.intercept(MASTER);
        await f.processor.replacementFor(MEDIA, liveWindow(138, 38, 16));
        const ad = liveWindow(100, 0, 55, { source: 'slate', ad: true, clockOffset: 350 });
        const replacement = await f.processor.replacementFor(MEDIA, ad);
        if (Object.keys(opts).length) {
            assert.equal(replacement, null);
            assert.equal(f.processor.stats.fallbacks, 0);
        } else {
            assert.match(replacement, /native-53\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-11-24T00:01:48\.000Z\n#EXTINF:2,live\n[^\n]+backup-54\.ts/);
            assert.equal(f.processor.stats.fallbacks, 1);
            assert.equal(f.processor.stats.spliceRejections.anchor, 1);
        }
        f.processor.stop();
    }
});
test('mid-roll selection prefers a strictly aligned embed feed over an experimental popout fallback', async () => {
    const f = fixture({ splice: true, adFallback: true, masters: { popout: avcMaster(BACKUP), embed: avcMaster(SECOND_BACKUP) },
        playlists: {
            [BACKUP]: liveWindow(9000, 39, 16, { source: 'fallback' }),
            [SECOND_BACKUP]: liveWindow(9100, 42, 16, { source: 'aligned' })
        } });
    await f.intercept(MASTER);
    await f.processor.replacementFor(MEDIA, liveWindow(138, 38, 16));
    const ad = liveWindow(100, 0, 58, { ad: true, clockOffset: 350 });
    const replacement = await f.processor.replacementFor(MEDIA, ad);
    assert.match(replacement, /second\/aligned-54\.ts[\s\S]+second\/aligned-57\.ts/);
    assert.doesNotMatch(replacement, /backup\/fallback-/);
    assert.equal(f.processor.stats.fallbacks, 0);
    assert.equal(f.processor.stats.backupCandidates, 2);
    assert.equal(f.processor.stats.backupSearchFailures, 0);
    f.processor.stop();
});
test('mid-roll selection picks the smallest program time gap among experimental joins', async () => {
    const f = fixture({ splice: true, adFallback: true, masters: { popout: avcMaster(BACKUP), embed: avcMaster(SECOND_BACKUP) },
        playlists: {
            [BACKUP]: liveWindow(9000, 40, 16, { source: 'larger-gap', clockOffset: 850, liveBase: 11000 }),
            [SECOND_BACKUP]: liveWindow(9100, 40, 16, { source: 'smaller-gap', clockOffset: 400, liveBase: 11000 })
        } });
    await f.intercept(MASTER);
    await f.processor.replacementFor(MEDIA, liveWindow(138, 38, 16));
    const replacement = await f.processor.replacementFor(MEDIA, liveWindow(100, 0, 55, { ad: true }));
    assert.match(replacement, /second\/smaller-gap-54\.ts/);
    assert.equal(f.processor.stats.fallbacks, 1);
    f.processor.stop();
});
test('mid-roll selection checks more than the first rendition and bounds probes per context', async () => {
    const third = new URL('/third/index.m3u8', BACKUP).href;
    const f = fixture({ splice: true, masters: { popout: avcVariants(MEDIA, BACKUP, BACKUP, SECOND_BACKUP, third), embed: avcMaster(MEDIA) },
        playlists: { [BACKUP]: advert, [SECOND_BACKUP]: clean, [third]: clean } });
    await f.intercept(MASTER);
    assert.match(await f.intercept(MEDIA), /second\/segment\.ts/);
    assert.equal(f.calls.filter(call => call.address === BACKUP).length, 1);
    assert.equal(f.calls.filter(call => call.address === third).length, 0);
    assert.equal(f.processor.stats.backupCandidates, 2);
    f.processor.stop();
});
test('an accepted backup stays in use until it fails, then another feed is tried immediately', async () => {
    const playlists = { [BACKUP]: clean, [SECOND_BACKUP]: clean };
    const f = fixture({ splice: true, masters: { popout: avcMaster(BACKUP), embed: avcMaster(SECOND_BACKUP) }, playlists });
    await f.intercept(MASTER);
    assert.match(await f.intercept(MEDIA), /backup\/segment\.ts/);
    assert.match(await f.intercept(MEDIA), /backup\/segment\.ts/);
    assert.equal(f.calls.filter(call => call.address.endsWith('/gql')).length, 2);

    playlists[BACKUP] = advert;
    assert.match(await f.intercept(MEDIA), /second\/segment\.ts/);
    assert.equal(f.calls.filter(call => call.address.endsWith('/gql')).length, 4);
    assert.equal(f.calls.filter(call => call.address === BACKUP).length, 3);
    assert.equal(f.processor.stats.backupSearchFailures, 0);
    f.processor.stop();
});
test('a shifted backup with inconsistent timestamps or a wrong Twitch sequence is rejected', async () => {
    const liveBase = 3555;
    const stable = liveWindow(3557, 2, 15, { liveBase, source: 'backup', clockOffset: -235 });
    for (const backup of [
        stable.replace('LIVE-SEQUENCE:3557', 'LIVE-SEQUENCE:3558'),
        stable.replace('00:00:07.765Z', '00:00:07.915Z')
    ]) {
        const f = fixture({ splice: true, backup });
        await f.intercept(MASTER);
        await f.processor.replacementFor(MEDIA, liveWindow(3556, 0, 16, { liveBase }));
        const ad = liveWindow(3518, -38, 55, { liveBase, source: 'slate', ad: true, clockOffset: 350 });
        assert.equal(await f.processor.replacementFor(MEDIA, ad), null);
        assert.equal(f.processor.stats.spliced, 0);
        assert.equal(f.processor.stats.spliceRejections.anchor, 1);
        f.processor.stop();
    }
});
test('an incompatible backup keeps the original response and unaligned past segments are never inserted', async () => {
    for (const backup of [
        liveWindow(9000, 38, 16, { source: 'backup' }),
        liveWindow(9000, 40, 16, { source: 'backup' }).replace('00:01:20.000Z', '00:01:20.500Z')
            .replace('00:01:48.000Z', '00:01:48.500Z'),
        liveWindow(9000, 39, 16, { source: 'backup' }).replace('#EXT-X-VERSION:7',
            '#EXT-X-VERSION:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"')
    ]) {
        const f = fixture({ splice: true, backup });
        await f.intercept(MASTER);
        await f.processor.replacementFor(MEDIA, liveWindow(138, 38, 16));
        assert.equal(await f.processor.replacementFor(MEDIA, liveWindow(100, 0, 55, { source: 'ad', ad: true })), null);
        assert.equal(f.processor.stats.spliced, 0);
        f.processor.stop();
    }
});
test('subsequent refreshes wait for the splice handoff and preserve the original URL when it fails', async () => {
    const opts = { splice: true, backup: liveWindow(9000, 39, 16, { source: 'backup' }) };
    const f = fixture(opts);
    await f.intercept(MASTER);
    await f.processor.replacementFor(MEDIA, liveWindow(138, 38, 16));
    let commit;
    const ad = { source: 'ad', ad: true };
    const first = await f.processor.replacementFor(MEDIA, liveWindow(100, 0, 55, ad), (ack, filtered) => {
        assert.equal(filtered, true);
        commit = ack;
        return true;
    });
    assert.match(first, /backup-54\.ts/);
    opts.backup = liveWindow(9001, 40, 16, { source: 'backup' });
    let finished = false;
    const pending = f.processor.replacementFor(MEDIA, liveWindow(100, 0, 56, ad)).then(body => { finished = true; return body; });
    await new Promise(setImmediate);
    assert.equal(finished, false);
    commit(false);
    const second = await pending;
    assert.match(second, /ad-54\.ts[\s\S]+backup-55\.ts/);
    assert.doesNotMatch(second, /backup-54\.ts/);
    f.processor.stop();
});
test('failed alternatives return original response, bounded retries and cooldown', async () => {
    const f = fixture({fail:true}); await f.intercept(MASTER); const r = await f.intercept(MEDIA);
    assert.equal(r, null); assert.equal(f.calls.filter(c => c.address.endsWith('/gql')).length,2);
    assert.equal(f.processor.stats.backupSearchFailures,1);
    assert.equal(f.processor.stats.backupCandidates,0);
    await f.intercept(MEDIA); assert.equal(f.calls.filter(c => c.address.endsWith('/gql')).length,2); f.processor.stop();
});
test('ad-filled alternatives and incompatible quality or codecs are never substituted', async () => {
    for (const opts of [{backupAds:true},{wrongQuality:true},{wrongCodec:true}]) {
        const f = fixture(opts); await f.intercept(MASTER); const r = await f.intercept(MEDIA);
        assert.equal(r, null); assert.equal(f.processor.stats.replacements,0);
        if (opts.wrongQuality || opts.wrongCodec) assert.ok(!f.calls.some(c => c.address === BACKUP));
        f.processor.stop();
    }
});
test('a substitute must preserve the same segment window, time anchor and discontinuity sequence', async () => {
    const date = '#EXT-X-PROGRAM-DATE-TIME:2026-11-07T00:00:00.000Z\n';
    const rejections = [
        ['windowSize', clean + '#EXTINF:2,\nsecond.ts\n'],
        ['mediaSequence', clean.replace('SEQUENCE:100', 'SEQUENCE:25')],
        ['discontinuity', clean.replace(date, '#EXT-X-DISCONTINUITY-SEQUENCE:1\n' + date)],
        ['duration', clean.replace('#EXTINF:2,', '#EXTINF:1,')],
        ['timestamp', clean.replace('00:00:00.000Z', '00:00:20.000Z')],
        ['missingAnchor', clean.replace(date, '')]
    ];
    for (const [reason, backup] of rejections) {
        const f = fixture({ backup });
        await f.intercept(MASTER);
        assert.equal(await f.intercept(MEDIA), null);
        assert.equal(f.processor.stats.replacements, 0);
        assert.equal(f.processor.stats.timelineMismatches, 1);
        assert.deepEqual(Object.entries(f.processor.stats.timelineRejections).filter(([, count]) => count), [[reason, 1]]);
        f.processor.stop();
    }
    const undated = fixture({ main: advert.replace(date, ''), backup: clean.replace(date, '').replace('segment.ts', new URL('segment.ts', MEDIA).href) });
    await undated.intercept(MASTER);
    await undated.intercept(MEDIA);
    assert.equal(undated.processor.stats.replacements, 1);
    undated.processor.stop();
});
test('unknown manifests, VOD and deceptive domains are passed through', async () => {
    const f = fixture();
    for (const address of ['https://ttvnw.net.evil.test/a.m3u8','https://unrelated.test/a.m3u8','https://usher.ttvnw.net/vod/123.m3u8',MEDIA]) await f.intercept(address);
    assert.equal(f.calls.length,3); assert.equal(f.processor.stats.replacements,0); f.processor.stop();
});
test('concurrent refreshes share a search but still validate their own segment windows', async () => {
    let release;
    const backupReady = new Promise(resolve => { release = resolve; });
    const f = fixture({ backupReady });
    await f.intercept(MASTER);
    const matching = f.processor.replacementFor(MEDIA, advert);
    const changed = f.processor.replacementFor(MEDIA, advert.replace('SEQUENCE:100', 'SEQUENCE:101'));
    release();
    assert.match(await matching, /backup\/segment\.ts/);
    assert.equal(await changed, null);
    assert.equal(f.calls.filter(call => call.address === BACKUP).length, 1);
    assert.equal(f.processor.stats.timelineRejections.mediaSequence, 1);
    f.processor.stop();
});
test('stopping while a replacement is pending preserves original response', async () => {
    const f = fixture(); await f.intercept(MASTER);
    const promise = f.intercept(MEDIA); f.processor.stop();
    assert.equal(await promise, null);
});
test('inspector accepts only local socket paths and hosted Twitch TV pages', () => {
    assert.equal(inspector.isTwitchPage({type:'page',url:'https://pewter-example.tv.twitch.tv/app-shell'}),true);
    for (const url of ['https://tv.twitch.tv.evil.test/','https://www.twitch.tv/','file:///app.html','https://user@tv.twitch.tv/']) assert.equal(inspector.isTwitchPage({type:'page',url}),false);
    assert.equal(inspector.localWebSocketPath('ws://127.0.0.1:7011/devtools/page/abcd',7011),'/devtools/page/abcd');
    for (const address of ['ws://example.test:7011/devtools/page/abc','ws://127.0.0.1:7011/arbitrary','ws://127.0.0.1:7012/devtools/page/abc']) assert.throws(() => inspector.localWebSocketPath(address,7011));
});
test('shared Twitch page discovery requires one target and checks cancellation before connecting', async () => {
    const originalListing = inspector.listTargets;
    const originalConnect = inspector.connect;
    const target = { type: 'page', url: 'https://samsung.tv.twitch.tv/', webSocketDebuggerUrl: 'local' };
    const otherPage = { ...target, url: 'https://www.twitch.tv/' };
    const client = {};
    const connections = [];
    let targets = [target, otherPage];
    inspector.listTargets = async () => targets;
    inspector.connect = async (address, port) => { connections.push([address, port]); return client; };
    try {
        await assert.rejects(inspector.openTwitchPage(7011, () => { throw Error('Cancelled'); }), /Cancelled/);
        for (const invalid of [null, [otherPage], [target, target]]) {
            targets = invalid;
            await assert.rejects(inspector.openTwitchPage(7011, () => {}), /Expected one hosted Twitch TV page/);
        }
        assert.deepEqual(connections, []);

        targets = [target, otherPage];
        assert.deepEqual(await inspector.openTwitchPage(7011, () => {}), { client, url: target.url });
        assert.deepEqual(connections, [['local', 7011]]);
    } finally {
        inspector.listTargets = originalListing;
        inspector.connect = originalConnect;
    }
});
test('disable during network registration removes interception and prevents reload', async () => {
    const originalListing=inspector.listTargets, originalConnect=inspector.connect;
    const calls=[]; let release, announce;
    const registered = new Promise(resolve => {announce=resolve});
    const c={on:()=>()=>{},call:async (method,params) => {
        calls.push([method,params]);
        if(method==='Network.setRequestInterception'&&params.patterns.length){announce(); return new Promise(resolve => {release=resolve});}
        return {};
    },close(){calls.push(['close'])}};
    inspector.listTargets=async () => [{type:'page',url:'https://samsung.tv.twitch.tv/',webSocketDebuggerUrl:'local'}];
    inspector.connect=async () => c;
    try {
        const instance=require('../plugins/twitch/filter/index.js')();instance.start();
        const finished=instance.attach(7011).then(()=>true,()=>false);
        await registered; const stopped=instance.stop();release({});
        await stopped;assert.equal(await finished,false);
        assert.ok(calls.some(([m,p]) => m==='Network.setRequestInterception'&&p.patterns.length===0));
        assert.ok(!calls.some(([m]) => m==='Page.reload'));
        assert.ok(calls.some(([m]) => m==='close'));
        assert.equal(instance.status().attached,false);
    } finally {inspector.listTargets=originalListing;inspector.connect=originalConnect;}
});
test('CDP transport validates upgrade, handles fragmented replies and closes on invalid messages', async () => {
    const http=require('node:http'), crypto=require('node:crypto');
    const server=http.createServer();let peer;
    const net=require('node:net'), connect=net.connect;
    // Bind the local fixture to 127.0.0.1; the production client connects to 127.0.0.2.
    net.connect=function(options){assert.equal(options.host,'127.0.0.2');return connect.call(net,Object.assign({},options,{host:'127.0.0.1'}));};
    function outgoing(payload,opcode=1,fin=true){const b=Buffer.from(payload);assert.ok(b.length<126);return Buffer.concat([Buffer.from([(fin?128:0)|opcode,b.length]),b]);}
    server.on('upgrade',(req,socket)=>{
        peer=socket;
        const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
        let input=Buffer.alloc(0);
        socket.on('data',chunk=>{
            input=Buffer.concat([input,chunk]);
            while(input.length>=2){
                const opcode=input[0]&15;let size=input[1]&127,off=2;
                if(size===126){if(input.length<4)return;size=input.readUInt16BE(2);off=4;}
                if(input.length<off+4+size)return;
                const mask=input.subarray(off,off+4),data=input.subarray(off+4,off+4+size);input=input.subarray(off+4+size);
                for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
                if(opcode!==1)continue;
                const msg=JSON.parse(data.toString());
                if (msg.method === 'Page.disable') { socket.write(outgoing('null')); continue; }
                const answer=JSON.stringify({id:msg.id,result:{identifier:'fixture'}});
                socket.write(outgoing(JSON.stringify({method:'constructor'})));
                socket.write(outgoing(answer.slice(0,12),1,false));socket.write(outgoing('ping',9));socket.write(outgoing(answer.slice(12),0,true));
            }
        });
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let client;
    try{
        const port=server.address().port;client=await inspector.connect('ws://127.0.0.1:'+port+'/devtools/page/fixture',port);
        assert.deepEqual(await client.call('Page.enable'),{identifier:'fixture'});
        await assert.rejects(client.call('Page.disable'), /Invalid inspector response/);
        assert.equal(client.isOpen(), false);
    }finally{net.connect=connect;if(client)client.close();if(peer)peer.destroy();await new Promise(resolve=>server.close(resolve));}
});
test('Chromium XHR interception processes masters and substitutes a clean ad-free media response',async()=>{
    const {createNetworkInterceptor}=require('../plugins/twitch/filter/index.js');const commands=[];let onEvent;
    const bodies={master:manifest(MEDIA),media:advert};
    const client={on(method,fn){assert.equal(method,'Network.requestIntercepted');onEvent=fn;return()=>{onEvent=null}},async call(method,args){
        commands.push([method,args]);
        if(method==='Network.getResponseBodyForInterception')return {body:bodies[args.interceptionId],base64Encoded:false};return {};
    }};
    const fixtureScope=fixture();
    const filter=createNetworkInterceptor(client,fixtureScope.requestText);await filter.start();
    async function emit(id,url){onEvent({interceptionId:id,request:{url},responseStatusCode:200,responseHeaders:{'Access-Control-Allow-Origin':'*','Content-Encoding':'gzip','ETag':'stale','Cache-Control':'max-age=30'}});for(let i=0;i<6;i++)await new Promise(setImmediate);}
    await emit('master',MASTER);await emit('media',MEDIA);
    const forwarded=commands.filter(([m])=>m==='Network.continueInterceptedRequest');
    assert.equal(forwarded[0][1].rawResponse,undefined);
    const raw=Buffer.from(forwarded[1][1].rawResponse,'base64').toString();
    assert.match(raw,/HTTP\/1.1 200 OK/);assert.match(raw,/Access-Control-Allow-Origin: \*/);assert.doesNotMatch(raw,/Content-Encoding:|ETag:|max-age=/i);
    assert.match(raw,/Cache-Control: no-store/);
    assert.match(raw,/backup\/segment.ts/);assert.equal(filter.status().filter.replacements,1);
    await filter.stop();assert.equal(filter.status().inFlight,0);assert.equal(onEvent,null);
});
test('Chromium XHR errors and non-200 responses continue the original request',async()=>{
    const {createNetworkInterceptor}=require('../plugins/twitch/filter/index.js');let handler;const forwarded=[];
    const client={on(m,fn){handler=fn;return()=>{}},async call(m,p){if(m==='Network.getResponseBodyForInterception')throw new Error('body unavailable');if(m==='Network.continueInterceptedRequest')forwarded.push(p);return {}}};
    const filter=createNetworkInterceptor(client);await filter.start();
    handler({interceptionId:'bad',request:{url:MEDIA},responseStatusCode:200});
    handler({interceptionId:'offline',request:{url:MEDIA},responseStatusCode:404});
    for(let i=0;i<4;i++)await new Promise(setImmediate);
    assert.equal(forwarded.length,2);assert.ok(forwarded.every(p=>!p.rawResponse));await filter.stop();
});
test('automatic attachment registers only network interception and never reloads the app',async()=>{
    const originalListing=inspector.listTargets,originalConnect=inspector.connect,calls=[];
    inspector.listTargets=async()=>[{type:'page',url:'https://samsung.tv.twitch.tv/',webSocketDebuggerUrl:'local'}];
    inspector.connect=async()=>({on:()=>()=>{},call:async(m,p)=>{calls.push([m,p]);return{}},close(){}});
    try{
        const instance=require('../plugins/twitch/filter/index.js')();instance.start();
        await instance.attach(7011);assert.ok(!calls.some(([m])=>/^Page\./.test(m)));await instance.stop();
        assert.ok(calls.some(([m,p])=>m==='Network.setRequestInterception'&&p.patterns.length===0));
    }finally{inspector.listTargets=originalListing;inspector.connect=originalConnect;}
});

test('replacement notifications require a successful CDP handoff and do not affect request continuation',async()=>{
 const {createNetworkInterceptor}=require('../plugins/twitch/filter/index.js');
 for(const scenario of ['replacement','clean','no-alternative','failed-handoff','stopped-before-ack','throwing-callback']){
  let handler,release,notifications=0;const forwarded=[];
  const bodies={master:manifest(MEDIA),media:scenario==='clean'?clean:advert};
  const client={on(m,fn){handler=fn;return()=>{}},async call(m,p){
   if(m==='Network.getResponseBodyForInterception')return{body:bodies[p.interceptionId]};
   if(m==='Network.continueInterceptedRequest'){
    forwarded.push(p);
    if(p.rawResponse&&scenario==='failed-handoff')throw Error('Handoff failed');
    if(p.rawResponse&&scenario==='stopped-before-ack')await new Promise(r=>release=r);
   }
   return{};
  }};
  const f=fixture({backupAds:scenario==='no-alternative'});
  const filter=createNetworkInterceptor(client,f.requestText,()=>{notifications++;if(scenario==='throwing-callback')throw Error('Optional UI error')});
  await filter.start();
  async function emit(id,url){handler({interceptionId:id,request:{url},responseStatusCode:200});for(let i=0;i<8;i++)await new Promise(setImmediate)}
  await emit('master',MASTER);assert.equal(notifications,0);await emit('media',MEDIA);
  if(scenario==='stopped-before-ack'){const stopping=filter.stop();release();await stopping}
  assert.equal(notifications,['replacement','throwing-callback'].includes(scenario)?1:0,scenario);
  assert.equal(forwarded.length,scenario==='failed-handoff'?3:2,scenario);assert.equal(filter.status().inFlight,0,scenario);
  if(scenario==='failed-handoff')assert.deepEqual(forwarded.at(-1),{interceptionId:'media'});
  assert.equal(filter.status().bodyFailures,scenario==='failed-handoff'?1:0,scenario);
  await filter.stop();f.processor.stop();
 }
});
