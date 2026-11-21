'use strict';
var url = require('url');
var MAX_PLAYLIST_LENGTH = 524288;
var REQUEST_TIMEOUT_MS = 1800, SEARCH_BUDGET_MS = 4500, RETRY_COOLDOWN_MS = 20000;
var STARTUP_PROBE_MS = 650;
var SEGMENT_TOLERANCE_MS = 100;

function parseUrl(address, base) {
    try {
        var parsed = url.parse(base ? url.resolve(base, address) : address);
        return parsed.protocol && parsed.hostname ? parsed : null;
    } catch (error) { return null; }
}
function isMediaPlaylist(parsed) {
    return !!parsed && parsed.protocol === 'https:' && !parsed.auth && (!parsed.port || parsed.port === '443') &&
        /(^|\.)ttvnw\.net$/.test(parsed.hostname) && /\.m3u8$/.test(parsed.pathname);
}
function create(fetchText) {
    var running = true, streamVariants = Object.create(null), masterReads = 0;
    var stats = { playlists: 0, ads: 0, replacements: 0, failures: 0,
        prerollsDetected: 0, prerollsReplaced: 0, prerollProbeFailures: 0, timelineMismatches: 0 };
    function containsAdvertising(text) {
        return /^#EXT-X-DATERANGE:.*CLASS="twitch-(?:stitched-ad|maf-ad)(?:-[^"]*)?"/m.test(text) ||
            /^#EXT-X-CUE-OUT(?::|$)/m.test(text);
    }
    function parseMaster(text, base) {
        var lines = text.split(/\r?\n/), result = [], info = null;
        lines.forEach(function (line) {
            if (/^#EXT-X-STREAM-INF:/.test(line)) {
                var res = /(?:[:,])RESOLUTION=(\d+x\d+)/.exec(line), fps = /(?:[:,])FRAME-RATE=([\d.]+)/.exec(line), codecs = /(?:[:,])CODECS="([^"]+)"/.exec(line);
                var groups = line.match(/(?:[:,])(?:VIDEO|AUDIO|SUBTITLES|CLOSED-CAPTIONS)=(?:"[^"]*"|[^,]*)/g);
                info = { resolution: res ? res[1] : null, fps: fps ? Number(fps[1]) : null,
                    codecs: codecs ? codecs[1].replace(/\s/g, '').toLowerCase() : null,
                    groups: (groups || []).map(function (group) { return group.slice(1); }).sort().join(',') };
            } else if (line && line.charAt(0) !== '#' && info) {
                var u = parseUrl(line, base);
                info.url = isMediaPlaylist(u) ? u.href : null;
                result.push(info);
                info = null;
            }
        });
        return result;
    }
    function resolveMediaUrls(text, base) {
        return text.split(/\r?\n/).map(function (line) {
            if (line && line.charAt(0) !== '#') { var u = parseUrl(line, base); return u ? u.href : line; }
            return line.replace(/URI="([^"]+)"/g, function (all, s) { var u = parseUrl(s, base); return u ? 'URI="' + u.href + '"' : all; });
        }).join('\n');
    }
    function isCleanPlaylist(text) { return /^#EXTM3U\b/.test(text) && /^#EXTINF:/m.test(text) && !containsAdvertising(text); }
    function mediaTimeline(text, base) {
        var sequence = 0, discontinuity = 0, date = null, duration = null, byteRange = false, segments = [];
        text.split(/\r?\n/).forEach(function (line) {
            if (line.charAt(0) === '#') {
                var separator = line.indexOf(':');
                var tag = separator < 0 ? line : line.slice(0, separator);
                var value = separator < 0 ? '' : line.slice(separator + 1);
                switch (tag) {
                    case '#EXT-X-MEDIA-SEQUENCE': sequence = Number(value); break;
                    case '#EXT-X-DISCONTINUITY-SEQUENCE': discontinuity = Number(value); break;
                    case '#EXT-X-DISCONTINUITY': discontinuity++; date = null; break;
                    case '#EXT-X-PROGRAM-DATE-TIME': date = Date.parse(value); break;
                    case '#EXT-X-BYTERANGE': byteRange = true; break;
                    case '#EXTINF': duration = Number(value.split(',')[0]) * 1000; break;
                }
            } else if (line && duration !== null) {
                var segmentUrl = byteRange ? null : parseUrl(line, base);
                segments.push({ sequence: sequence++, discontinuity: discontinuity, date: date,
                    duration: duration, url: segmentUrl && segmentUrl.href });
                if (date !== null) date += duration;
                duration = null;
                byteRange = false;
            }
        });
        return segments;
    }
    function preservesTimeline(before, after) {
        var anchored = false;
        if (!before.length || before.length !== after.length) return false;
        // The player sees a refresh of the same URL. Keep the segment window and require a common time or segment anchor.
        var matches = before.every(function (segment, index) {
            var next = after[index];
            if (index && segment.discontinuity !== before[index - 1].discontinuity) {
                if (!anchored) return false;
                anchored = false;
            }
            if (segment.sequence !== next.sequence || segment.discontinuity !== next.discontinuity ||
                !(segment.duration > 0 && next.duration > 0 && Math.abs(segment.duration - next.duration) <= SEGMENT_TOLERANCE_MS)) return false;
            if (segment.date !== null && next.date !== null) {
                if (!(Math.abs(segment.date - next.date) <= SEGMENT_TOLERANCE_MS)) return false;
                anchored = true;
            } else if (segment.url && segment.url === next.url) anchored = true;
            return true;
        });
        return matches && anchored;
    }
    function requestWithinBudget(address, options, deadline) {
        var remaining = deadline - Date.now();
        if (!running || remaining <= 0) return Promise.reject(new Error('Search budget exhausted'));
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(new Error('Twitch request timed out')); }, Math.min(REQUEST_TIMEOUT_MS, remaining));
            Promise.resolve().then(function () {
                if (!running) throw new Error('Filter stopped');
                return fetchText(address, options);
            }).then(function (text) {
                clearTimeout(timer);
                resolve(text);
            }, function (error) { clearTimeout(timer); reject(error); });
        });
    }
    function matchingVariant(list, originalVariant) {
        return list.filter(function (v) { return v.url && v.resolution === originalVariant.resolution && v.fps === originalVariant.fps && (!originalVariant.codecs || v.codecs === originalVariant.codecs); })[0];
    }
    function alternatePlayback(lookup) {
        return lookup('popout').catch(function () { return lookup('embed'); });
    }
    function readAlternative(address, deadline, originalTimeline) {
        return requestWithinBudget(address, {}, deadline).then(function (text) {
            if (!isCleanPlaylist(text)) throw new Error('No clean backup');
            var timeline = mediaTimeline(text, address);
            if (!preservesTimeline(originalTimeline, timeline)) {
                stats.timelineMismatches++;
                throw new Error('Backup timeline differs');
            }
            return { url: address, body: resolveMediaUrls(text, address), timeline: timeline };
        });
    }
    function requestAlternateMaster(master, channel, type, deadline) {
        var body = { query: 'query($login:String!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType}){value signature}}',
            variables: { login: channel, playerType: type } };
        return requestWithinBudget('https://gql.twitch.tv/gql', { method: 'POST', headers: {
            'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json'
        }, body: JSON.stringify(body) }, deadline).then(function (raw) {
            var data = JSON.parse(raw), token = data.data && data.data.streamPlaybackAccessToken;
            if (!token || typeof token.value !== 'string' || typeof token.signature !== 'string') throw new Error('no token');
            var masterUrl = url.parse(master, true);
            masterUrl.search = null;
            masterUrl.query.token = token.value;
            masterUrl.query.sig = token.signature;
            var address = url.format(masterUrl);
            return requestWithinBudget(address, {}, deadline).then(function (text) {
                return { url: address, body: text, variants: parseMaster(text, address) };
            });
        });
    }
    function rememberVariants(master, channel, variants, playback) {
        // Manifest URLs and playback grants stay in this bounded memory cache.
        if (++masterReads > 32) { streamVariants = Object.create(null); masterReads = 1; }
        variants.slice(0, 32).forEach(function (variant) {
            if (!variant.url || !variant.resolution) return;
            if (streamVariants[variant.url] && streamVariants[variant.url].playback === playback) return;
            streamVariants[variant.url] = { channel: channel, master: master, resolution: variant.resolution, fps: variant.fps,
                codecs: variant.codecs, playback: playback, tried: 0, backup: null, pending: null };
        });
    }
    function renditionLayout(text, variants) {
        if (!variants.length || variants.some(function (variant) { return !variant.url; })) return null;
        var signatures = variants.map(function (variant) {
            return JSON.stringify([variant.resolution, variant.fps, variant.codecs, variant.groups]);
        });
        var tracks = text.split(/\r?\n/).filter(function (line) { return /^#EXT-X-MEDIA:/.test(line); });
        tracks.forEach(function (line) { signatures.push(line.replace(/,URI="[^"]*"|URI="[^"]*",/g, '')); });
        return signatures.sort().join('\n');
    }
    function replacePrerollMaster(address, text, channel) {
        var variants = parseMaster(text, address);
        var reference = variants.filter(function (variant) { return variant.url && variant.resolution; })[0];
        if (!reference) return Promise.resolve(null);
        var knownVariant = streamVariants[reference.url];
        var playback = knownVariant ? knownVariant.playback : { mediaStarted: false, pending: null };
        rememberVariants(address, channel, variants, playback);
        // A refreshed master shares this flag with both the original and alternate rendition URLs.
        if (playback.mediaStarted) return Promise.resolve(null);
        if (playback.pending) return playback.pending;
        var deadline = Date.now() + SEARCH_BUDGET_MS;
        playback.pending = requestWithinBudget(reference.url, {}, Date.now() + STARTUP_PROBE_MS).then(function (media) {
            if (!containsAdvertising(media)) return null;
            stats.prerollsDetected++;
            var layout = renditionLayout(text, variants);
            if (!layout) return null;
            // Switching at the master gives Chromium new rendition URLs and their own media sequences.
            return alternatePlayback(function (type) {
                return requestAlternateMaster(address, channel, type, deadline).then(function (alternate) {
                    if (renditionLayout(alternate.body, alternate.variants) !== layout) throw new Error('Rendition layout differs');
                    var candidate = matchingVariant(alternate.variants, reference);
                    if (!candidate || candidate.url === reference.url) throw new Error('Alternate rendition URL unavailable');
                    return requestWithinBudget(candidate.url, {}, deadline).then(function (playlist) {
                        if (!isCleanPlaylist(playlist)) throw new Error('Alternate rendition has ads');
                        return alternate;
                    });
                });
            }).then(function (alternate) {
                if (!running || playback.mediaStarted || Date.now() >= deadline) return null;
                rememberVariants(alternate.url, channel, alternate.variants, playback);
                stats.prerollsReplaced++;
                stats.replacements++;
                return resolveMediaUrls(alternate.body, alternate.url);
            }).catch(function () { stats.failures++; return null; });
        }, function () {
            if (running) stats.prerollProbeFailures++;
            return null;
        }).then(function (replacement) {
            playback.pending = null;
            return replacement;
        });
        return playback.pending;
    }
    function findCleanAlternative(variantState, originalTimeline) {
        if (variantState.pending) return variantState.pending;
        var deadline = Date.now() + SEARCH_BUDGET_MS, work;
        if (variantState.backup) {
            work = readAlternative(variantState.backup, deadline, originalTimeline).catch(function () { variantState.backup = null; return null; });
        } else if (Date.now() - variantState.tried < RETRY_COOLDOWN_MS) return Promise.resolve(null);
        else {
            variantState.tried = Date.now();
            work = alternatePlayback(function (type) {
                return requestAlternateMaster(variantState.master, variantState.channel, type, deadline).then(function (alternate) {
                    var picked = matchingVariant(alternate.variants, variantState);
                    if (!picked) throw new Error('Quality differs');
                    return readAlternative(picked.url, deadline, originalTimeline);
                });
            }).then(function (replacement) {
                if (running && Date.now() < deadline) variantState.backup = replacement.url;
                return replacement;
            });
        }
        variantState.pending = work.catch(function () { stats.failures++; return null; }).then(function (replacement) {
            variantState.pending = null;
            return running && Date.now() < deadline ? replacement : null;
        });
        return variantState.pending;
    }
    function replacementFor(address, text) {
        var u = parseUrl(address);
        if (!running || !isMediaPlaylist(u) || typeof text !== 'string' || text.length > MAX_PLAYLIST_LENGTH) return Promise.resolve(null);
        return Promise.resolve().then(function () {
            if (!running) return null;
            stats.playlists++;
            var channel = /^\/api\/channel\/hls\/([A-Za-z0-9_]+)\.m3u8$/.exec(u.pathname);
            if (channel && u.hostname === 'usher.ttvnw.net') return replacePrerollMaster(u.href, text, channel[1]);
            var variantState = streamVariants[u.href];
            if (variantState) variantState.playback.mediaStarted = true;
            if (!variantState || !containsAdvertising(text)) { if (variantState) variantState.backup = null; return null; }
            stats.ads++;
            var timeline = mediaTimeline(text, u.href);
            return findCleanAlternative(variantState, timeline).then(function (replacement) {
                if (!running || !replacement) return null;
                // A pending search can be shared by refreshes with different segment windows.
                if (!preservesTimeline(timeline, replacement.timeline)) { stats.timelineMismatches++; stats.failures++; return null; }
                stats.replacements++;
                return replacement.body;
            });
        }).catch(function () { stats.failures++; return null; });
    }

    return { stats: stats, replacementFor: replacementFor, stop: function () {
        running = false; streamVariants = Object.create(null);
    } };
}
module.exports = { create: create, isMediaPlaylist: isMediaPlaylist };
