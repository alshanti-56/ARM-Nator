(() => {
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(location.hostname) || window.__armNatorAdFilter) {
        return;
    }

    window.__armNatorAdFilter = true;

    const ARM_NATOR_EMBEDDED_COMMAND_CHANNEL = 'BROWSER:EMBEDDED_COMMAND';
    let armNatorIpcRenderer = null;
    try {
        armNatorIpcRenderer =
            typeof require === 'function' ? require('electron').ipcRenderer : null;
    } catch {
        armNatorIpcRenderer = null;
    }

    const sendArmNatorCommand = command => {
        if (armNatorIpcRenderer) {
            armNatorIpcRenderer.send(ARM_NATOR_EMBEDDED_COMMAND_CHANNEL, command);
        }
    };

    const playerButtonDefinitions = {
        full: [
            {
                command: 'youtube-native-mini-player',
                label: 'YouTube Miniplayer',
                icon: 'youtube-mini',
            },
            {
                command: 'arm-mini-player',
                label: 'ARM-Nator Miniplayer',
                icon: 'arm-mini',
            },
            {
                command: 'terminate-playback',
                label: 'Terminate playback',
                icon: 'terminate',
            },
        ],
        mini: [
            {
                command: 'restore-arm-mini-player',
                label: 'Restore YouTube player',
                icon: 'restore',
            },
            {
                command: 'terminate-playback',
                label: 'Terminate playback',
                icon: 'terminate',
            },
        ],
    };

    const ARM_NATOR_PLAYER_CONTROLS_ID = 'arm-nator-player-controls';
    const ARM_NATOR_PLAYER_STOP_ID = 'arm-nator-player-stop';
    const ARM_NATOR_PLAYER_CONTROLS_STYLE_ID = 'arm-nator-player-controls-style';
    const ARM_NATOR_RELATED_SCROLL_STYLE_ID =
        'arm-nator-related-video-scroll-style';

    const installPlayerControlsStyle = () => {
        if (document.getElementById(ARM_NATOR_PLAYER_CONTROLS_STYLE_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = ARM_NATOR_PLAYER_CONTROLS_STYLE_ID;
        style.textContent = `
            #${ARM_NATOR_PLAYER_CONTROLS_ID},
            #${ARM_NATOR_PLAYER_STOP_ID} {
                align-items: center !important;
                display: inline-flex !important;
                height: 100% !important;
                margin: 0 !important;
                vertical-align: top !important;
            }
            #${ARM_NATOR_PLAYER_CONTROLS_ID} .arm-nator-player-control,
            #${ARM_NATOR_PLAYER_STOP_ID} .arm-nator-player-control {
                align-items: center !important;
                background: transparent !important;
                border: 0 !important;
                color: #fff !important;
                cursor: pointer !important;
                display: inline-flex !important;
                height: 100% !important;
                justify-content: center !important;
                opacity: .9 !important;
                padding: 0 !important;
                width: 48px !important;
            }
            #${ARM_NATOR_PLAYER_CONTROLS_ID} .arm-nator-player-control:hover,
            #${ARM_NATOR_PLAYER_CONTROLS_ID} .arm-nator-player-control:focus-visible,
            #${ARM_NATOR_PLAYER_STOP_ID} .arm-nator-player-control:hover,
            #${ARM_NATOR_PLAYER_STOP_ID} .arm-nator-player-control:focus-visible {
                background: rgba(255, 255, 255, .16) !important;
                opacity: 1 !important;
                outline: 0 !important;
            }
            #${ARM_NATOR_PLAYER_CONTROLS_ID} svg,
            #${ARM_NATOR_PLAYER_STOP_ID} svg {
                fill: none !important;
                height: 24px !important;
                stroke: currentColor !important;
                stroke-linecap: round !important;
                stroke-linejoin: round !important;
                stroke-width: 1.8 !important;
                width: 24px !important;
            }
            #${ARM_NATOR_PLAYER_CONTROLS_ID} .arm-nator-player-control[data-icon='youtube-mini'] svg path:nth-child(2),
            #${ARM_NATOR_PLAYER_CONTROLS_ID} .arm-nator-player-control[data-icon='terminate'] svg path:nth-child(2),
            #${ARM_NATOR_PLAYER_STOP_ID} .arm-nator-player-control[data-icon='youtube-mini'] svg path:nth-child(2),
            #${ARM_NATOR_PLAYER_STOP_ID} .arm-nator-player-control[data-icon='terminate'] svg path:nth-child(2) {
                fill: currentColor !important;
                stroke: none !important;
            }
        `;
        (document.head || document.documentElement).append(style);
    };

    const installRelatedVideoScrollStyle = () => {
        if (document.getElementById(ARM_NATOR_RELATED_SCROLL_STYLE_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = ARM_NATOR_RELATED_SCROLL_STYLE_ID;
        style.textContent = `
            html:not([data-arm-nator-mini-player='true']) #secondary {
                height: calc(100vh - 104px) !important;
                max-height: calc(100vh - 104px) !important;
                overflow-y: auto !important;
                overscroll-behavior: contain !important;
                scrollbar-gutter: stable;
            }
        `;
        (document.head || document.documentElement).append(style);
    };

    const createPlayerControl = definition => {
        const button = document.createElement('button');
        button.className = 'ytp-button arm-nator-player-control';
        button.type = 'button';
        button.dataset.icon = definition.icon;
        button.setAttribute('aria-label', definition.label);
        button.title = definition.label;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('viewBox', '0 0 24 24');
        const addIconElement = (tagName, attributes) => {
            const element = document.createElementNS(
                'http://www.w3.org/2000/svg',
                tagName
            );
            for (const [name, value] of Object.entries(attributes)) {
                element.setAttribute(name, value);
            }
            svg.append(element);
        };
        switch (definition.icon) {
            case 'youtube-mini':
                addIconElement('rect', { x: '2.5', y: '3.5', width: '19', height: '16', rx: '1.5' });
                addIconElement('path', { d: 'M12 12h8v6h-8z' });
                break;
            case 'arm-mini':
                addIconElement('rect', { x: '3', y: '4', width: '18', height: '14', rx: '1.5' });
                addIconElement('path', { d: 'M6 21h12' });
                addIconElement('path', { d: 'M10 18v3' });
                addIconElement('path', { d: 'M14 18v3' });
                break;
            case 'restore':
                addIconElement('path', { d: 'M8 4H4v4' });
                addIconElement('path', { d: 'M4 8a8 8 0 1 1 2 8' });
                addIconElement('path', { d: 'M4 4l4 4' });
                break;
            case 'terminate':
                addIconElement('circle', { cx: '12', cy: '12', r: '9.5' });
                addIconElement('path', { d: 'M9 9h6v6H9z' });
                break;
        }
        button.append(svg);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            sendArmNatorCommand(definition.command);
        });
        return button;
    };

    const ensureArmNatorPlayerControls = () => {
        const rightControls = document.querySelector('.ytp-right-controls');
        if (!(rightControls instanceof HTMLElement)) {
            return;
        }

        const player = rightControls.closest('.html5-video-player');
        if (!(player instanceof HTMLElement)) {
            return;
        }

        installPlayerControlsStyle();
        installRelatedVideoScrollStyle();
        const leftControls = player.querySelector('.ytp-left-controls');
        let group = rightControls.querySelector(`#${ARM_NATOR_PLAYER_CONTROLS_ID}`);
        if (!(group instanceof HTMLElement)) {
            group = document.createElement('span');
            group.id = ARM_NATOR_PLAYER_CONTROLS_ID;
            const rightControlsRight = rightControls.querySelector(
                '.ytp-right-controls-right'
            );
            if (rightControlsRight) {
                rightControls.insertBefore(group, rightControlsRight);
            } else {
                rightControls.append(group);
            }
        }

        const mode =
            document.documentElement?.getAttribute('data-arm-nator-mini-player') ===
            'true'
                ? 'mini'
                : 'full';
        const definitions =
            mode === 'mini'
                ? playerButtonDefinitions.mini
                : playerButtonDefinitions.full;
        if (group.dataset.mode !== mode) {
            group.replaceChildren();
            for (const definition of definitions) {
                if (definition.command !== 'terminate-playback') {
                    group.append(createPlayerControl(definition));
                }
            }
            group.dataset.mode = mode;
        }

        if (leftControls instanceof HTMLElement) {
            let stopControl = leftControls.querySelector(
                `#${ARM_NATOR_PLAYER_STOP_ID}`
            );
            if (!(stopControl instanceof HTMLElement)) {
                stopControl = document.createElement('span');
                stopControl.id = ARM_NATOR_PLAYER_STOP_ID;
                const playButton = leftControls.querySelector('.ytp-play-button');
                if (playButton) {
                    playButton.insertAdjacentElement('afterend', stopControl);
                } else {
                    leftControls.prepend(stopControl);
                }
            }
            if (stopControl.dataset.mode !== mode) {
                stopControl.replaceChildren();
                const terminateDefinition = definitions.find(
                    definition => definition.command === 'terminate-playback'
                );
                if (terminateDefinition) {
                    stopControl.append(createPlayerControl(terminateDefinition));
                }
                stopControl.dataset.mode = mode;
            }
        }
    };

    const scheduleArmNatorPlayerControls = () => {
        window.setTimeout(ensureArmNatorPlayerControls, 0);
    };

    for (const event of [
        'DOMContentLoaded',
        'hashchange',
        'popstate',
        'yt-navigate-finish',
    ]) {
        window.addEventListener(event, scheduleArmNatorPlayerControls, {
            passive: true,
        });
    }
    const observeArmNatorPlayerControls = () => {
        const root = document.documentElement;
        if (!(root instanceof HTMLElement)) {
            window.setTimeout(observeArmNatorPlayerControls, 50);
            return;
        }
        new MutationObserver(scheduleArmNatorPlayerControls).observe(root, {
            childList: true,
            subtree: true,
        });
    };
    observeArmNatorPlayerControls();
    window.setInterval(ensureArmNatorPlayerControls, 750);
    scheduleArmNatorPlayerControls();

    document.addEventListener(
        'click',
        event => {
            if (
                document.documentElement?.getAttribute('data-arm-nator-mini-player') ===
                'true'
            ) {
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest('.ytp-fullscreen-button')) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            sendArmNatorCommand('youtube-fullscreen');
        },
        true
    );
    document.addEventListener(
        'keydown',
        event => {
            if (event.key !== 'Escape' || !window.__armNatorAppFullscreen) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            sendArmNatorCommand('youtube-fullscreen');
        },
        true
    );

    // ARM-Nator's mini-player and YouTube's in-page Miniplayer are separate
    // display modes. Do not let YouTube create a second nested player while
    // the app-owned mini view is active; restore it to the YouTube page first.
    document.addEventListener(
        'click',
        event => {
            if (
                document.documentElement?.getAttribute('data-arm-nator-mini-player') !==
                'true'
            ) {
                return;
            }

            const target = event.target instanceof Element ? event.target : null;
            const miniplayerButton = target?.closest('.ytp-miniplayer-button');
            const menuItem = target?.closest('[role="menuitem"]');
            const isMiniplayerMenuItem =
                menuItem?.textContent?.trim().toLowerCase() === 'miniplayer';

            if (!miniplayerButton && !isMiniplayerMenuItem) {
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();
        },
        true
    );

    (() => {
        if (window.__armNatorSponsorBlock) {
            return;
        }

        window.__armNatorSponsorBlock = true;

        const sponsorBlockEndpoint = 'https://sponsor.ajay.app/api/skipSegments/';
        const cacheTtlMs = 10 * 60 * 1000;
        const failureCacheTtlMs = 30 * 1000;
        const segmentCache = new Map();
        const pendingLookups = new Map();
        const state = {
            videoId: null,
            segments: [],
            video: null,
            listeners: [],
            skipTimeout: null,
            noticeTimeout: null,
        };

        const clearSkipTimeout = () => {
            if (state.skipTimeout !== null) {
                window.clearTimeout(state.skipTimeout);
                state.skipTimeout = null;
            }
        };

        const removeNotice = () => {
            if (state.noticeTimeout !== null) {
                window.clearTimeout(state.noticeTimeout);
                state.noticeTimeout = null;
            }
            document.getElementById('arm-nator-sponsorblock-notice')?.remove();
        };

        const unbindVideo = () => {
            clearSkipTimeout();
            if (state.video) {
                for (const [event, listener] of state.listeners) {
                    state.video.removeEventListener(event, listener);
                }
            }
            state.video = null;
            state.listeners = [];
        };

        const getVideoId = () => {
            let url;
            try {
                url = new URL(location.href);
            } catch {
                return null;
            }

            let videoId = url.searchParams.get('v');
            const pathParts = url.pathname.split('/').filter(Boolean);
            if (!videoId && ['shorts', 'embed', 'live'].includes(pathParts[0])) {
                videoId = pathParts[1];
            }
            if (!videoId && /(^|\.)youtu\.be$/i.test(url.hostname)) {
                videoId = pathParts[0];
            }

            return /^[A-Za-z0-9_-]{11}$/.test(videoId || '') ? videoId : null;
        };

        const hashVideoId = async videoId => {
            const bytes = new TextEncoder().encode(videoId);
            const digest = await window.crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest), byte =>
                byte.toString(16).padStart(2, '0')
            ).join('').slice(0, 4);
        };

        const cacheSegments = (videoId, segments, ttlMs) => {
            segmentCache.set(videoId, {
                segments,
                expiresAt: Date.now() + ttlMs,
            });
            while (segmentCache.size > 32) {
                segmentCache.delete(segmentCache.keys().next().value);
            }
        };

        const getSponsorSegments = async videoId => {
            const cached = segmentCache.get(videoId);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.segments;
            }

            const pending = pendingLookups.get(videoId);
            if (pending) {
                return pending;
            }

            const lookup = (async () => {
                try {
                    const hashPrefix = await hashVideoId(videoId);
                    const params = new URLSearchParams();
                    params.set('categories', JSON.stringify(['sponsor']));
                    params.set('actionTypes', JSON.stringify(['skip']));
                    params.set('trimUUIDs', 'true');

                    const controller = new AbortController();
                    const timeout = window.setTimeout(() => controller.abort(), 5000);
                    let response;
                    try {
                        response = await window.fetch(
                            `${sponsorBlockEndpoint}${hashPrefix}?${params.toString()}`,
                            {
                                method: 'GET',
                                mode: 'cors',
                                credentials: 'omit',
                                cache: 'no-store',
                                headers: {
                                    Accept: 'application/json',
                                    'X-CLIENT-NAME': 'Arm-Nator',
                                },
                                signal: controller.signal,
                            }
                        );
                    } finally {
                        window.clearTimeout(timeout);
                    }

                    if (!response.ok) {
                        cacheSegments(videoId, [], failureCacheTtlMs);
                        return [];
                    }

                    const payload = await response.json();
                    const receivedSegments = Array.isArray(payload)
                        ? payload.find(entry => entry?.videoID === videoId)?.segments
                        : null;
                    const segments = Array.isArray(receivedSegments)
                        ? receivedSegments
                              .filter(segment => {
                                  const [start, end] = segment?.segment || [];
                                  return (
                                      segment?.category === 'sponsor' &&
                                      segment?.actionType === 'skip' &&
                                      Number.isFinite(start) &&
                                      Number.isFinite(end) &&
                                      end > start
                                  );
                              })
                              .map(segment => ({
                                  start: segment.segment[0],
                                  end: segment.segment[1],
                              }))
                              .sort((left, right) => left.start - right.start)
                        : [];

                    cacheSegments(videoId, segments, cacheTtlMs);
                    return segments;
                } catch (error) {
                    console.debug('[Arm-Nator] SponsorBlock lookup unavailable', error);
                    cacheSegments(videoId, [], failureCacheTtlMs);
                    return [];
                }
            })();

            pendingLookups.set(videoId, lookup);
            try {
                return await lookup;
            } finally {
                pendingLookups.delete(videoId);
            }
        };

        const showSkipNotice = () => {
            removeNotice();
            const notice = document.createElement('div');
            notice.id = 'arm-nator-sponsorblock-notice';
            notice.setAttribute('role', 'status');
            Object.assign(notice.style, {
                alignItems: 'center',
                background: 'rgba(18, 18, 18, 0.92)',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                borderRadius: '8px',
                bottom: '72px',
                color: '#fff',
                display: 'flex',
                fontFamily: 'system-ui, sans-serif',
                fontSize: '13px',
                gap: '5px',
                padding: '8px 11px',
                position: 'fixed',
                right: '16px',
                zIndex: '2147483647',
            });
            notice.append('Sponsor skipped · ');
            const link = document.createElement('a');
            link.href = 'https://sponsor.ajay.app/';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'SponsorBlock';
            link.style.color = '#8ab4f8';
            notice.append(link);
            (document.body || document.documentElement).append(notice);
            state.noticeTimeout = window.setTimeout(removeNotice, 1800);
        };

        const scheduleNextSkip = () => {
            clearSkipTimeout();
            const video = state.video;
            if (!video || !state.segments.length || video.paused || video.ended) {
                return;
            }
            if (video.readyState < 3 || video.seeking) {
                return;
            }

            const currentTime = video.currentTime;
            const activeSegment = state.segments.find(
                segment => currentTime >= segment.start && currentTime < segment.end
            );
            if (activeSegment) {
                try {
                    video.currentTime = activeSegment.end;
                    showSkipNotice();
                } catch {
                    // The video can be replaced while YouTube is changing routes.
                }
                return;
            }

            const nextSegment = state.segments.find(segment => segment.start > currentTime);
            if (!nextSegment) {
                return;
            }

            const playbackRate = video.playbackRate > 0 ? video.playbackRate : 1;
            const delay = Math.max(
                50,
                ((nextSegment.start - currentTime) / playbackRate) * 1000 - 40
            );
            state.skipTimeout = window.setTimeout(scheduleNextSkip, delay);
        };

        const bindVideo = video => {
            if (state.video === video) {
                scheduleNextSkip();
                return;
            }

            unbindVideo();
            state.video = video;
            const listener = () => scheduleNextSkip();
            for (const event of [
                'canplay',
                'durationchange',
                'loadedmetadata',
                'playing',
                'ratechange',
                'seeked',
                'timeupdate',
            ]) {
                state.video.addEventListener(event, listener, { passive: true });
                state.listeners.push([event, listener]);
            }
            scheduleNextSkip();
        };

        const refreshSponsorBlock = async () => {
            const videoId = getVideoId();
            if (videoId !== state.videoId) {
                unbindVideo();
                removeNotice();
                state.videoId = videoId;
                state.segments = [];
            }

            if (!videoId) {
                return;
            }

            const video = document.querySelector('video.html5-main-video, video');
            if (!state.segments.length) {
                state.segments = await getSponsorSegments(videoId);
                if (state.videoId !== videoId) {
                    return;
                }
            }
            if (video) {
                bindVideo(video);
            }
        };

        for (const event of ['DOMContentLoaded', 'hashchange', 'popstate', 'yt-navigate-finish']) {
            window.addEventListener(event, refreshSponsorBlock, { passive: true });
        }
        window.setInterval(refreshSponsorBlock, 750);
        void refreshSponsorBlock();
    })();

    const removedKeys = new Set([
        'adPlacements',
        'adSlots',
        'playerAds',
        'productsInVideoOverlayRenderer',
    ]);
    const removedRenderers = new Set([
        'adSlotRenderer',
        'searchPyvRenderer',
        'bannerPromoRenderer',
        'statementBannerRenderer',
        'brandVideoShelfRenderer',
        'brandVideoSingletonRenderer',
    ]);
    const pageAdSelectors = [
        'ytd-ad-slot-renderer',
        'ytd-in-feed-ad-layout-renderer',
        'ytd-display-ad-renderer',
        'ytd-promoted-sparkles-web-renderer',
        'ytd-search-pyv-renderer',
        'ytd-banner-promo-renderer',
        'ytd-statement-banner-renderer',
        'ytd-companion-slot-renderer',
        '.ytp-ad-player-overlay',
        '.ytp-ad-overlay-container',
        '.ytp-ad-text',
        '.ytp-ad-message-container',
        '.ytp-ad-skip-button-container',
    ].join(',');

    const isObject = value => value !== null && typeof value === 'object';

    const isAdRenderer = value => {
        if (!isObject(value) || Array.isArray(value)) {
            return false;
        }

        if (Object.keys(value).some(key => removedRenderers.has(key))) {
            return true;
        }

        return isObject(value.content)
            && Object.keys(value.content).some(key => removedRenderers.has(key));
    };

    const sanitize = (value, parentKey = '') => {
        if (!isObject(value)) {
            return value;
        }

        if (Array.isArray(value)) {
            for (let index = value.length - 1; index >= 0; index -= 1) {
                if (isAdRenderer(value[index])) {
                    value.splice(index, 1);
                } else {
                    sanitize(value[index], parentKey);
                }
            }
            return value;
        }

        for (const key of Object.keys(value)) {
            if (removedKeys.has(key) || removedRenderers.has(key)) {
                delete value[key];
                continue;
            }

            if (parentKey === 'richGridRenderer' && (key === 'masthead' || key === 'bigYoodle')) {
                delete value[key];
                continue;
            }

            sanitize(value[key], key);
        }

        return value;
    };

    const isYouTubeApiRequest = input => {
        const url = typeof input === 'string' ? input : input?.url;
        return typeof url === 'string' && (url.includes('/youtubei/') || url.includes('youtube.com/api/'));
    };

    const originalFetch = window.fetch;
    window.fetch = new Proxy(originalFetch, {
        apply(target, thisArg, argumentsList) {
            const request = argumentsList[0];
            const promise = Reflect.apply(target, thisArg, argumentsList);

            if (!isYouTubeApiRequest(request)) {
                return promise;
            }

            return promise.then(response => response.clone().text().then(text => {
                try {
                    const cleanText = text.startsWith(")]}'\n") ? text.slice(5) : text;
                    const data = JSON.parse(cleanText);
                    sanitize(data);
                    return new Response(JSON.stringify(data), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                } catch {
                    return response;
                }
            }).catch(() => response));
        },
    });

    const wrapInitialData = key => {
        const descriptor = Object.getOwnPropertyDescriptor(window, key);
        if (descriptor?.configurable === false) {
            return;
        }

        let currentValue = descriptor?.get?.call(window) ?? descriptor?.value;
        Object.defineProperty(window, key, {
            configurable: true,
            enumerable: descriptor?.enumerable ?? true,
            get: () => currentValue,
            set: value => {
                currentValue = sanitize(value);
            },
        });

        if (currentValue) {
            currentValue = sanitize(currentValue);
        }
    };

    wrapInitialData('ytInitialData');
    wrapInitialData('ytInitialPlayerResponse');

    const removePageAds = () => {
        document.querySelectorAll(pageAdSelectors).forEach(element => element.remove());
    };

    const observer = new MutationObserver(removePageAds);
    const startObserver = () => {
        if (document.documentElement) {
            observer.observe(document.documentElement, {childList: true, subtree: true});
            removePageAds();
        } else {
            requestAnimationFrame(startObserver);
        }
    };

    startObserver();
})();
