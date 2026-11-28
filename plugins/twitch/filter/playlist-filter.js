'use strict';
// Chooses a clean HLS feed for a live stream. Before playback starts, Chromium can receive a
// different master playlist and start with that feed's segment numbers. During playback the
// media playlist needs to preserve the numbers and URLs that the player has already seen.
// A null result tells the interceptor to deliver Twitch's original body.

var url = require('url');
var MAX_PLAYLIST_LENGTH = 524288;
var REQUEST_TIMEOUT_MS = 1800, SEARCH_BUDGET_MS = 4500, RETRY_COOLDOWN_MS = 20000;
var STARTUP_PROBE_MS = 650;
var PLAYBACK_CONTEXTS = ['popout', 'embed'];
var CANDIDATES_PER_CONTEXT = 2;
var SEGMENT_TOLERANCE_MS = 100;
var MAX_CLOCK_SKEW_MS = 1000;
var PRESENTATION_SEGMENTS = 24;
var LIVE_MASTER_PATH = /^\/api\/(?:v2\/)?channel\/hls\/([A-Za-z0-9_]+)\.m3u8$/;
var DELIVERY_DIRECTIVE = /^_HLS_(?:msn|part|skip)(?:=|$)/;
var AD_TAG = /^#EXT-X-CUE-OUT(?:-CONT)?(?::|$)|^#EXT-X-DATERANGE(?=:).*?[:,][ \t]*(?:(?:ID|CLASS)="(?:twitch-)?(?:stitched|maf)-ad(?:-[^"\r\n]*)?"|X-TV-TWITCH-AD-[A-Z0-9-]+=)/m;
var UNSAFE_TO_REBASE = /^#EXT-X-(?:SKIP|PART|PRELOAD-HINT|RENDITION-REPORT|BYTERANGE):|^#EXT-X-GAP\s*$|^#EXT-X-KEY:(?!METHOD=NONE(?:,|\s*$))/m;
var UNSAFE_TO_SPLICE = /^#EXT-X-(?:ENDLIST|PLAYLIST-TYPE|I-FRAMES-ONLY|DEFINE)(?::|\s*$)/m;

function parseUrl(address, base) {
    try {
        var parsed = url.parse(base ? url.resolve(base, address) : address);
        return parsed.protocol && parsed.hostname ? parsed : null;
    } catch (error) { return null; }
}
function isTwitchMedia(parsed) {
    return !!parsed && parsed.protocol === 'https:' && !parsed.auth && (!parsed.port || parsed.port === '443') &&
        /(^|\.)ttvnw\.net$/.test(parsed.hostname);
}
function isMediaPlaylist(parsed) {
    return isTwitchMedia(parsed) && /\.m3u8$/.test(parsed.pathname);
}
function renditionKey(parsed) {
    if (!parsed.search) return parsed.host + parsed.pathname;
    var parameters = parsed.search.slice(1).split('&').filter(function (part) { return !DELIVERY_DIRECTIVE.test(part); });
    return parsed.host + parsed.pathname + (parameters.length ? '?' + parameters.join('&') : '');
}

// Playlist parsing, timeline checks and rendering do not depend on the active filter.
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
            info.key = info.url && renditionKey(u);
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
function isCleanPlaylist(text) { return /^#EXTM3U\b/.test(text) && /^#EXTINF:/m.test(text) && !AD_TAG.test(text); }
function mediaTimeline(text, base) {
    var sequence = 0, liveSequence = null, discontinuity = 0, date = null, duration = null, byteRange = false, segments = [];
    var target = 0, version = 3, map = null, cut = false, title = '';
    // A delta update omits part of its window. Other LL-HLS tags can carry their own sequence references.
    text.split(/\r?\n/).forEach(function (line) {
        if (line.charAt(0) === '#') {
            var separator = line.indexOf(':');
            var tag = separator < 0 ? line : line.slice(0, separator);
            var value = separator < 0 ? '' : line.slice(separator + 1);
            switch (tag) {
                case '#EXT-X-MEDIA-SEQUENCE': sequence = Number(value); break;
                case '#EXT-X-TWITCH-LIVE-SEQUENCE': liveSequence = /^\d{1,15}$/.test(value) ? Number(value) : null; break;
                case '#EXT-X-VERSION': version = Number(value); break;
                case '#EXT-X-TARGETDURATION': target = Number(value); break;
                case '#EXT-X-DISCONTINUITY-SEQUENCE': discontinuity = Number(value); break;
                case '#EXT-X-DISCONTINUITY': discontinuity++; date = null; cut = true; break;
                case '#EXT-X-PROGRAM-DATE-TIME': date = Date.parse(value); break;
                case '#EXT-X-BYTERANGE': byteRange = true; break;
                case '#EXT-X-MAP': map = resolveMediaUrls(line, base); break;
                case '#EXTINF':
                    var comma = value.indexOf(',');
                    duration = Number(comma < 0 ? value : value.slice(0, comma)) * 1000;
                    title = comma < 0 ? '' : value.slice(comma + 1);
                    break;
            }
        } else if (line && duration !== null) {
            var segmentUrl = byteRange ? null : parseUrl(line, base);
            segments.push({ sequence: sequence++, discontinuity: discontinuity, date: date,
                duration: duration, url: segmentUrl && segmentUrl.href, map: map, cut: cut, title: title });
            if (date !== null) date += duration;
            duration = null;
            byteRange = false;
            cut = false;
        }
    });
    return { segments: segments, liveSequence: liveSequence, delta: /^#EXT-X-SKIP:/m.test(text),
        canRebase: !UNSAFE_TO_REBASE.test(text), canSplice: !UNSAFE_TO_SPLICE.test(text),
        target: target, version: version };
}
function lastSegment(segments) { return segments[segments.length - 1]; }
function usableSegment(segment) {
    var map = segment.map && /URI="([^"]+)"/.exec(segment.map);
    return isTwitchMedia(parseUrl(segment.url)) && (!segment.map || map && isTwitchMedia(parseUrl(map[1]))) &&
        isFinite(segment.date) && segment.date !== null &&
        segment.duration > 0 && segment.sequence >= 0 && segment.sequence < 1e15 && segment.sequence % 1 === 0 &&
        segment.discontinuity >= 0 && segment.discontinuity % 1 === 0;
}
function nativePresentation(timeline) {
    var segments = timeline.segments.slice(-PRESENTATION_SEGMENTS);
    if (!segments.length || !timeline.canRebase || !timeline.canSplice || !segments.every(usableSegment) ||
        !(timeline.target > 0 && timeline.target % 1 === 0 && timeline.version > 0 && timeline.version % 1 === 0)) return null;
    if (segments.some(function (segment) { return Math.round(segment.duration / 1000) > timeline.target; })) return null;
    var offset = timeline.liveSequence === null ? null : timeline.liveSequence - timeline.segments[0].sequence;
    return { segments: segments, target: timeline.target, version: timeline.version, offset: offset, mixed: false, source: null,
        clockSkew: null, sourceDiscontinuity: lastSegment(segments).discontinuity };
}
function matchingTime(a, b, shift) {
    return a.date !== null && b.date !== null && Math.abs(a.date - b.date - (shift || 0)) <= SEGMENT_TOLERANCE_MS &&
        Math.abs(a.duration - b.duration) <= SEGMENT_TOLERANCE_MS;
}
function clockSkew(reference, source) {
    if (!reference || reference.offset === null || source.liveSequence === null || !source.segments.length) return null;
    // Twitch counts live segments across sessions, while MEDIA-SEQUENCE can be local to one session.
    var first = reference.segments[0].sequence + reference.offset, minimum = Infinity, maximum = -Infinity, samples = 0;
    for (var index = 0; index < source.segments.length; index++) {
        var prior = reference.segments[source.liveSequence + index - first], next = source.segments[index];
        if (!prior) continue;
        if (!/^live\b/i.test(next.title) || !usableSegment(next) ||
            Math.abs(prior.duration - next.duration) > SEGMENT_TOLERANCE_MS) return null;
        var difference = prior.date - next.date;
        if (Math.abs(difference) > Math.min(MAX_CLOCK_SKEW_MS, prior.duration / 2)) return null;
        minimum = Math.min(minimum, difference);
        maximum = Math.max(maximum, difference);
        samples++;
    }
    return samples >= 3 && maximum - minimum <= SEGMENT_TOLERANCE_MS ? (minimum + maximum) / 2 : null;
}
function spliceWindow(previous, original, source, sourceId, reference, rejectSplice) {
    function reject(reason) { if (rejectSplice) rejectSplice(reason); return null; }
    if (!previous) return reject('history');
    if (!original.canRebase || !original.canSplice || !source.canRebase || !source.canSplice ||
        !(source.version > 0 && source.version % 1 === 0)) return reject('format');
    var calibrated = sourceId ? (previous.source === sourceId ? previous.clockSkew : clockSkew(reference, source)) : null;
    var shift = calibrated === null ? 0 : calibrated;
    var originalSegments = original.segments, segments = previous.segments.slice(), last = lastSegment(segments);
    var firstIndex = last.sequence + 1 - (originalSegments[0] || {}).sequence;
    if (!(firstIndex >= 0 && firstIndex < originalSegments.length)) return reject('sequence');
    var first = originalSegments[firstIndex], candidateIndex = 0, anchored = false;
    if (sourceId) {
        // The ad can use a different clock. Prefer the last segment already offered to the player.
        while (candidateIndex < source.segments.length && !matchingTime(last, source.segments[candidateIndex], shift)) candidateIndex++;
        if (candidateIndex < source.segments.length && usableSegment(source.segments[candidateIndex])) {
            candidateIndex++;
            anchored = true;
        }
    }
    if (!anchored) {
        if (!usableSegment(first)) return reject('anchor');
        candidateIndex = 0;
        while (candidateIndex < source.segments.length && !matchingTime(first, source.segments[candidateIndex], shift)) candidateIndex++;
        if (candidateIndex === source.segments.length) return reject('anchor');
    }
    if (source.segments.length - candidateIndex < originalSegments.length - firstIndex) return reject('coverage');
    var previousSourceDiscontinuity = previous.sourceDiscontinuity;
    for (var index = firstIndex; index < originalSegments.length; index++, candidateIndex++) {
        var expected = originalSegments[index], candidate = source.segments[candidateIndex];
        if (!usableSegment(candidate) || calibrated !== null && !/^live\b/i.test(candidate.title) ||
            (!anchored && (!usableSegment(expected) || !matchingTime(expected, candidate, shift))) ||
            !!candidate.map !== !!last.map || Math.round(candidate.duration / 1000) > previous.target ||
            Math.abs(candidate.date + shift - last.date - last.duration) > SEGMENT_TOLERANCE_MS) return reject('boundary');
        // A change of feed or initialization data needs a decoder boundary.
        var cut = candidate.cut || candidate.map !== last.map || candidate.discontinuity !== previousSourceDiscontinuity ||
            (index === firstIndex && sourceId !== previous.source);
        last = { sequence: expected.sequence, date: candidate.date + shift, duration: candidate.duration, url: candidate.url, map: candidate.map,
            title: candidate.title, discontinuity: last.discontinuity + (cut ? 1 : 0), cut: cut };
        segments.push(last);
        previousSourceDiscontinuity = candidate.discontinuity;
    }
    return { segments: segments.slice(-PRESENTATION_SEGMENTS), target: previous.target,
        version: Math.max(previous.version, source.version || 3), offset: previous.offset, mixed: true,
        source: sourceId, clockSkew: calibrated, sourceDiscontinuity: previousSourceDiscontinuity };
}
function fallbackWindow(previous, source, sourceId) {
    if (!previous || !source.canRebase || !source.canSplice || !source.segments.length ||
        !(source.version > 0 && source.version % 1 === 0)) return null;
    var segments = previous.segments.slice(), last = lastSegment(segments), cursor = previous.fallback;
    var sameSource = cursor && previous.source === sourceId, nextDate = (cursor ? cursor.date : last.date) + last.duration;
    var first = source.segments[0], newest = lastSegment(source.segments), start;
    if (sameSource) {
        start = Math.max(0, cursor.sequence + 1 - first.sequence);
        if (start >= source.segments.length) return Date.now() - cursor.advanced < previous.target * 2000 ? previous : null;
    } else {
        // Prefer the next program time. A source without a shared clock starts near its live edge.
        start = source.segments.findIndex(function (segment) {
            return segment.date !== null && segment.date >= nextDate - segment.duration / 2;
        });
        if (start < 0 && !sourceId && cursor && nextDate - newest.date <= previous.target * 1000 &&
            Date.now() - cursor.advanced < previous.target * 2000) return previous;
        if (start < 0) start = source.segments.length - 1;
        start = Math.max(start, source.segments.length - PRESENTATION_SEGMENTS / 2);
    }
    // Keep the published tail and give the decoder a boundary when a feed or timestamp sequence changes.
    var sourceDiscontinuity = previous.sourceDiscontinuity, sourceEnd = cursor && cursor.date + last.duration;
    var end = Math.min(source.segments.length, start + PRESENTATION_SEGMENTS / 2);
    for (var index = start; index < end; index++) {
        var candidate = source.segments[index];
        if (!usableSegment(candidate) || !!candidate.map !== !!last.map ||
            Math.round(candidate.duration / 1000) > previous.target) return null;
        var cut = candidate.cut || candidate.map !== last.map || candidate.discontinuity !== sourceDiscontinuity ||
            (index === start && !sameSource) || Math.abs(candidate.date - sourceEnd) > SEGMENT_TOLERANCE_MS;
        last = { sequence: last.sequence + 1, date: last.date + last.duration, duration: candidate.duration,
            url: candidate.url, map: candidate.map, title: candidate.title, discontinuity: last.discontinuity + (cut ? 1 : 0), cut: cut };
        segments.push(last);
        sourceDiscontinuity = candidate.discontinuity;
        sourceEnd = candidate.date + candidate.duration;
    }
    var tail = source.segments[end - 1];
    return { segments: segments.slice(-PRESENTATION_SEGMENTS), target: previous.target,
        version: Math.max(previous.version, source.version), offset: previous.offset, mixed: true, source: sourceId,
        clockSkew: null, sourceDiscontinuity: sourceDiscontinuity,
        fallback: { sequence: tail.sequence, date: tail.date, advanced: Date.now(),
            gap: sameSource ? 0 : Math.abs(source.segments[start].date - nextDate) } };
}
function renderPresentation(presentation) {
    var first = presentation.segments[0], offset = presentation.offset;
    var lines = ['#EXTM3U', '#EXT-X-VERSION:' + presentation.version, '#EXT-X-TARGETDURATION:' + presentation.target,
        '#EXT-X-MEDIA-SEQUENCE:' + first.sequence];
    if (offset !== null) lines.push('#EXT-X-TWITCH-LIVE-SEQUENCE:' + (first.sequence + offset));
    lines.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + (first.discontinuity - (first.cut ? 1 : 0)));
    var currentMap = null;
    presentation.segments.forEach(function (segment) {
        if (segment.cut) lines.push('#EXT-X-DISCONTINUITY');
        if (segment.map && segment.map !== currentMap) { lines.push(segment.map); currentMap = segment.map; }
        if (presentation.adCue && segment.sequence === presentation.adCue.sequence) lines = lines.concat(presentation.adCue.tags);
        lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(segment.date).toISOString(),
            '#EXTINF:' + segment.duration / 1000 + ',' + segment.title, segment.url);
    });
    return lines.join('\n') + '\n';
}
function timelineMismatch(original, alternative, rebase) {
    var before = original.segments, after = alternative.segments, anchored = false;
    if (!before.length || before.length !== after.length) return 'windowSize';
    if (original.delta || alternative.delta) return 'unsupportedPlaylist';
    if (!(before[0].sequence >= 0 && before[0].sequence < 1e15 && before[0].sequence % 1 === 0 &&
          after[0].sequence >= 0 && after[0].sequence < 1e15 && after[0].sequence % 1 === 0)) return 'mediaSequence';
    if (rebase) {
        if (original.liveSequence === null || original.liveSequence !== alternative.liveSequence) return 'mediaSequence';
        if (!original.canRebase || !alternative.canRebase) return 'unsupportedPlaylist';
    }
    // The player sees a refresh of the same URL. Keep the segment window and require a common time or segment anchor.
    for (var index = 0; index < before.length; index++) {
        var segment = before[index], next = after[index];
        if (index && segment.discontinuity !== before[index - 1].discontinuity) {
            if (!anchored) return 'missingAnchor';
            anchored = false;
        }
        if (!rebase && segment.sequence !== next.sequence) return 'mediaSequence';
        if (segment.discontinuity !== next.discontinuity) return 'discontinuity';
        if (!(segment.duration > 0 && next.duration > 0 && Math.abs(segment.duration - next.duration) <= SEGMENT_TOLERANCE_MS))
            return 'duration';
        if (segment.date !== null && next.date !== null) {
            if (!(Math.abs(segment.date - next.date) <= SEGMENT_TOLERANCE_MS)) return 'timestamp';
            anchored = true;
        } else if (rebase) return 'missingAnchor';
        else if (segment.url && segment.url === next.url) anchored = true;
    }
    return anchored ? null : 'missingAnchor';
}

// Use the same rendition signatures for startup and mid-stream replacements.
function compatibleVariants(list, original) {
    var sameGroups = [], otherGroups = [];
    list.forEach(function (variant) {
        if (!variant.url || variant.key === original.key || variant.resolution !== original.resolution ||
            variant.fps !== original.fps || original.codecs && variant.codecs !== original.codecs) return;
        (variant.groups === original.groups ? sameGroups : otherGroups).push(variant);
    });
    return sameGroups.concat(otherGroups);
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

function replacementRank(replacement, plan, previous) {
    var presentation = plan.presentation, fallback = presentation && presentation.fallback;
    var tail = lastSegment(replacement.timeline.segments);
    var endTime = tail && tail.date !== null ? tail.date + tail.duration : Infinity;
    // Prefer alignment, then new segments, matching groups, a smaller gap and a fresher tail.
    return [
        fallback ? 1 : 0,
        presentation && presentation === previous ? 1 : 0,
        replacement.sameGroups ? 0 : 1,
        fallback ? fallback.gap : 0,
        isFinite(endTime) ? -endTime : Infinity
    ];
}
function outranks(rank, best) {
    for (var index = 0; index < rank.length; index++) {
        if (rank[index] !== best[index]) return rank[index] < best[index];
    }
    return false;
}

function alternatePlayback(lookup) {
    return lookup(PLAYBACK_CONTEXTS[0]).catch(function () { return lookup(PLAYBACK_CONTEXTS[1]); });
}

function createPlaylistFilter(fetchText, allowFallback) {
    allowFallback = allowFallback || function () { return false; };
    var running = true, streamVariants = Object.create(null), masterReads = 0;
    var stats = { playlists: 0, ads: 0, unmappedAds: 0, replacements: 0, failures: 0, rebased: 0, spliced: 0,
        prerollsDetected: 0, prerollsReplaced: 0, prerollProbeFailures: 0, timelineMismatches: 0, fallbacks: 0,
        backupCandidates: 0, backupSearchFailures: 0,
        timelineRejections: { windowSize: 0, mediaSequence: 0, discontinuity: 0, duration: 0, timestamp: 0, missingAnchor: 0, unsupportedPlaylist: 0 },
        spliceRejections: { rendition: 0, history: 0, format: 0, sequence: 0, anchor: 0, coverage: 0, boundary: 0 } };
    function alignReplacement(original, replacement, previous, reference) {
        if (previous && previous.fallback) return null;
        var before = original.segments[0], after = replacement.timeline.segments[0];
        var rebase = before && after && before.sequence !== after.sequence;
        var reason = timelineMismatch(original, replacement.timeline, rebase);
        if (reason === 'windowSize' || previous && previous.mixed) {
            if (replacement.spliceCompatible) {
                var presentation = spliceWindow(previous, original, replacement.timeline, replacement.url, reference, function (reason) {
                    stats.spliceRejections[reason]++;
                });
                if (presentation) return { body: renderPresentation(presentation), presentation: presentation };
            } else stats.spliceRejections.rendition++;
        }
        // Once the player has received a splice, shared segment numbers must keep the URLs it saw.
        if (previous && previous.mixed && !reason) reason = 'missingAnchor';
        if (reason) {
            stats.timelineMismatches++;
            stats.timelineRejections[reason]++;
            return null;
        }
        var body = resolveMediaUrls(replacement.text, replacement.url);
        if (!rebase) return { body: body, rebased: false };
        var tag = '#EXT-X-MEDIA-SEQUENCE:' + before.sequence;
        body = /^#EXT-X-MEDIA-SEQUENCE:/m.test(body) ? body.replace(/^#EXT-X-MEDIA-SEQUENCE:[^\n]*/m, tag) :
            body.replace(/^#EXTM3U[^\n]*\n/, '$&' + tag + '\n');
        return { body: body, rebased: true };
    }
    function chooseReplacement(original, replacement, previous, reference) {
        var aligned = alignReplacement(original, replacement, previous, reference);
        if (aligned || !allowFallback() || !replacement.spliceCompatible ||
            !original.canRebase || !original.canSplice) return aligned;
        var switched = fallbackWindow(previous, replacement.timeline, replacement.url);
        return switched ? { body: renderPresentation(switched), presentation: switched } : null;
    }
    function bestReplacement(alternatives, timeline, previous, reference) {
        var best = null;
        alternatives.forEach(function (replacement) {
            // A pending search can be shared by refreshes with different segment windows.
            var sameWindow = timeline === replacement.original && previous === replacement.previous && reference === replacement.reference;
            var plan = sameWindow ? replacement.aligned : chooseReplacement(timeline, replacement, previous, reference);
            if (!plan || plan.presentation && plan.presentation.fallback && !allowFallback()) return;
            var rank = replacementRank(replacement, plan, previous);
            if (!best || outranks(rank, best.rank)) best = { candidate: replacement.candidate, plan: plan, rank: rank };
        });
        return best;
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
                if (running && Date.now() <= deadline) resolve(text);
                else reject(new Error('Search budget exhausted'));
            }, function (error) { clearTimeout(timer); reject(error); });
        });
    }
    function readAlternative(variantState, picked, deadline, originalTimeline) {
        var address = picked.url;
        return requestWithinBudget(address, {}, deadline).then(function (text) {
            if (!isCleanPlaylist(text)) throw new Error('No clean backup');
            var sameGroups = picked.groups === variantState.groups;
            var result = { url: address, text: text, timeline: mediaTimeline(text, address), original: originalTimeline,
                previous: variantState.presentation, reference: variantState.cleanReference, candidate: picked, sameGroups: sameGroups,
                spliceCompatible: sameGroups && !!variantState.codecs && picked.codecs === variantState.codecs };
            result.aligned = chooseReplacement(originalTimeline, result, result.previous, result.reference);
            return result;
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
            if (streamVariants[variant.key] && streamVariants[variant.key].playback === playback) return;
            streamVariants[variant.key] = { key: variant.key, channel: channel, master: master, resolution: variant.resolution, fps: variant.fps,
                codecs: variant.codecs, groups: variant.groups, playback: playback, tried: 0, backup: null, pending: null,
                presentation: null, cleanReference: null, delivery: null, received: 0, delivered: 0 };
        });
    }
    function replacePrerollMaster(address, text, channel) {
        var variants = parseMaster(text, address);
        var reference = variants.filter(function (variant) { return variant.url && variant.resolution; })[0];
        if (!reference) return Promise.resolve(null);
        var knownVariant = streamVariants[reference.key];
        var playback = knownVariant ? knownVariant.playback : { mediaStarted: false, pending: null };
        rememberVariants(address, channel, variants, playback);
        // A refreshed master shares this flag with both the original and alternate rendition URLs.
        if (playback.mediaStarted) return Promise.resolve(null);
        if (playback.pending) return playback.pending;
        var deadline = Date.now() + SEARCH_BUDGET_MS;
        playback.pending = requestWithinBudget(reference.url, {}, Date.now() + STARTUP_PROBE_MS).then(function (media) {
            if (!AD_TAG.test(media)) return null;
            stats.prerollsDetected++;
            var layout = renditionLayout(text, variants);
            if (!layout) return null;
            // Switching at the master gives Chromium new rendition URLs and their own media sequences.
            return alternatePlayback(function (type) {
                return requestAlternateMaster(address, channel, type, deadline).then(function (alternate) {
                    if (renditionLayout(alternate.body, alternate.variants) !== layout) throw new Error('Rendition layout differs');
                    var candidate = compatibleVariants(alternate.variants, reference)[0];
                    if (!candidate) throw new Error('Alternate rendition URL unavailable');
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
    function searchBackups(variantState, originalTimeline, deadline, failedKey) {
        var now = Date.now();
        if (!running || now >= deadline || now - variantState.tried < RETRY_COOLDOWN_MS) return Promise.resolve([]);
        variantState.tried = now;
        var seen = Object.create(null);
        if (failedKey) seen[failedKey] = true;
        return Promise.all(PLAYBACK_CONTEXTS.map(function (type) {
            return requestAlternateMaster(variantState.master, variantState.channel, type, deadline).then(function (alternate) {
                var candidates = compatibleVariants(alternate.variants, variantState), reads = [];
                for (var index = 0; index < candidates.length && reads.length < CANDIDATES_PER_CONTEXT; index++) {
                    var candidate = candidates[index];
                    if (seen[candidate.key]) continue;
                    seen[candidate.key] = true;
                    stats.backupCandidates++;
                    reads.push(readAlternative(variantState, candidate, deadline, originalTimeline).catch(function () { return null; }));
                }
                return Promise.all(reads);
            }).catch(function () { return []; });
        })).then(function (groups) {
            var alternatives = Array.prototype.concat.apply([], groups).filter(Boolean);
            if (running && !alternatives.some(function (candidate) { return candidate.aligned; })) {
                stats.backupSearchFailures++;
                stats.failures++;
            }
            return alternatives;
        });
    }
    function findBackups(variantState, originalTimeline) {
        if (variantState.pending) return variantState.pending;
        var deadline = Date.now() + SEARCH_BUDGET_MS, backup = variantState.backup, work;
        if (backup) {
            work = readAlternative(variantState, backup, deadline, originalTimeline).catch(function () { return null; }).then(function (replacement) {
                if (replacement && replacement.aligned) return [replacement];
                variantState.backup = null;
                return searchBackups(variantState, originalTimeline, deadline, backup.key);
            });
        } else work = searchBackups(variantState, originalTimeline, deadline);
        variantState.pending = work.catch(function () { stats.failures++; return []; }).then(function (alternatives) {
            variantState.pending = null;
            return running ? alternatives : [];
        });
        return variantState.pending;
    }
    function replaceMediaPlaylist(playlistUrl, text, registerDeliveryCallback) {
        var variant = streamVariants[renditionKey(playlistUrl)];
        var hasAds = AD_TAG.test(text);
        if (hasAds) stats.ads++;
        if (!variant) {
            if (hasAds) stats.unmappedAds++;
            return null;
        }

        variant.playback.mediaStarted = true;
        var refresh = ++variant.received;
        var timeline = mediaTimeline(text, playlistUrl.href);

        function isCurrent() {
            return running && refresh >= variant.delivered;
        }

        // A later refresh must base its segment URLs on what Chromium actually received.
        function afterPendingDelivery(work) {
            if (!variant.delivery) return work();
            return variant.delivery.then(function () { return afterPendingDelivery(work); });
        }

        function respond(body, presentation, notifyReplacement, backup) {
            function commitPresentation(replaced) {
                if (!isCurrent()) return;
                variant.delivered = refresh;
                var native = !replaced || !hasAds ? nativePresentation(timeline) : null;
                variant.presentation = replaced ? presentation : native;
                if (backup) {
                    variant.backup = backup;
                    variant.tried = 0;
                    if (replaced && presentation && presentation.fallback) stats.fallbacks++;
                }
                if (!hasAds && native && native.offset !== null && native.segments.every(function (segment) {
                    return /^live\b/i.test(segment.title);
                })) variant.cleanReference = native;
            }

            if (!registerDeliveryCallback) {
                commitPresentation(!!body);
                return body;
            }

            var release;
            var delivery = new Promise(function (resolve) { release = resolve; });
            variant.delivery = delivery;
            function finish(replaced) {
                try {
                    commitPresentation(replaced);
                } finally {
                    if (variant.delivery === delivery) variant.delivery = null;
                    release();
                }
            }
            if (!registerDeliveryCallback(finish, notifyReplacement)) finish(false);
            return body;
        }

        function continueNative() {
            var previous = variant.presentation;
            if (!previous || !previous.mixed) return respond(null, null, false);

            var next = previous.fallback ? fallbackWindow(previous, timeline, null) :
                spliceWindow(previous, timeline, timeline, null);
            if (!next && timeline.canRebase && timeline.canSplice) {
                var newest = lastSegment(timeline.segments);
                var alreadySent = lastSegment(previous.segments);
                if (newest && newest.sequence === alreadySent.sequence && usableSegment(newest) && matchingTime(newest, alreadySent)) {
                    next = previous;
                }
            }
            if (!next) return respond(null, null, false);

            // Keep the URLs previously sent to the player while new segments come from Twitch again.
            if (hasAds && next !== previous) {
                var cueSequence = previous.adCue ? previous.adCue.sequence : lastSegment(previous.segments).sequence + 1;
                next.adCue = { sequence: Math.max(next.segments[0].sequence, cueSequence),
                    tags: text.split(/\r?\n/).filter(function (line) { return AD_TAG.test(line); }) };
            }
            return respond(renderPresentation(next), next, false);
        }

        function useBackup(alternatives) {
            if (!isCurrent()) return null;
            var selected = bestReplacement(alternatives, timeline, variant.presentation, variant.cleanReference);
            if (!selected) return continueNative();

            var plan = selected.plan;
            stats.replacements++;
            if (plan.rebased) stats.rebased++;
            if (plan.presentation) stats.spliced++;
            return respond(plan.body, plan.presentation || null, true, selected.candidate);
        }

        return afterPendingDelivery(function () {
            if (!isCurrent()) return null;
            if (!hasAds) {
                variant.backup = null;
                variant.tried = 0;
                return continueNative();
            }
            return findBackups(variant, timeline).then(function (alternatives) {
                return afterPendingDelivery(function () { return useBackup(alternatives); });
            });
        });
    }

    function replacementFor(address, text, registerDeliveryCallback) {
        var playlistUrl = parseUrl(address);
        if (!running || !isMediaPlaylist(playlistUrl) || typeof text !== 'string' || text.length > MAX_PLAYLIST_LENGTH) {
            return Promise.resolve(null);
        }
        return Promise.resolve().then(function () {
            if (!running) return null;
            stats.playlists++;
            var master = playlistUrl.hostname === 'usher.ttvnw.net' && LIVE_MASTER_PATH.exec(playlistUrl.pathname);
            return master ? replacePrerollMaster(playlistUrl.href, text, master[1]) :
                replaceMediaPlaylist(playlistUrl, text, registerDeliveryCallback);
        }).catch(function () {
            stats.failures++;
            return null;
        });
    }

    return {
        stats: stats,
        replacementFor: replacementFor,
        stop: function () {
            running = false;
            streamVariants = Object.create(null);
        }
    };
}
module.exports = { create: createPlaylistFilter, isMediaPlaylist: isMediaPlaylist };
