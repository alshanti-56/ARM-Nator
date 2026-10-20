import { Injectable, inject } from '@angular/core';
import { DataService } from '@arm-nator/services';
import {
    StalkerAuthApi,
    abortableStalkerRequest,
    buildStalkerExternalPlaybackHeaders,
    getStalkerPortalIdentityFromPlaylist,
    resolveStalkerPlaybackUrl,
    resolveStalkerStaticPlaybackUrl,
} from '@arm-nator/providers/stalker/data-access';
import { createLogger } from '@arm-nator/providers/shared/util';
import type { Playlist } from '@arm-nator/shared/interfaces';
import type { UserAgentProfile } from './user-agent-profiles';
import { probeUserAgentMedia, runUserAgentTests, type UserAgentTestResult } from './user-agent-test-runner';

type Channel = { id?: string | number; cmd: string; name?: string; use_http_tmp_link?: unknown; use_load_balancing?: unknown };
type PortalResponse = { js?: { data?: Channel[]; cmd?: string }; cmd?: string };

@Injectable()
export class PlaylistUserAgentTestService {
    private readonly data = inject(DataService);
    private readonly auth = new StalkerAuthApi(this.data, createLogger('UserAgentTest'));

    async run(
        playlist: Playlist,
        profiles: readonly UserAgentProfile[],
        signal: AbortSignal,
        publish: (result: UserAgentTestResult) => void,
        samplesLoaded: (names: string[]) => void,
    ): Promise<void> {
        const bridge = window.electron;
        if (!playlist.portalUrl || !playlist.macAddress || !bridge?.prepareAutoPlayback) {
            throw new Error('Stream testing is available for saved Stalker sources in the desktop app.');
        }
        const portalUrl = playlist.portalUrl;
        const macAddress = playlist.macAddress;
        const authSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const authentication = await this.auth.authenticate(
            portalUrl, macAddress, getStalkerPortalIdentityFromPlaylist(playlist),
            { storedToken: playlist.stalkerToken, credentials: { username: playlist.username, password: playlist.password }, signal: authSignal },
        );
        signal.throwIfAborted();
        const request = async (params: Record<string, string | number>, requestSignal: AbortSignal): Promise<PortalResponse> =>
            abortableStalkerRequest(this.data, {
                url: portalUrl,
                macAddress,
                token: authentication.token,
                serialNumber: playlist.stalkerSerialNumber ?? playlist.serialNumber,
                accountRef: playlist._id,
                params: { ...params, JsHttpRequest: '1-xml' },
            }, requestSignal);
        const channels = async (requestSignal: AbortSignal): Promise<Channel[]> => {
            const response = await request({ type: 'itv', action: 'get_ordered_list', p: 1, genre: '*', fav: 0 }, requestSignal);
            const rows = response?.js?.data;
            return Array.isArray(rows) ? rows.filter((row) => typeof row?.cmd === 'string' && row.cmd.trim()) : [];
        };
        const samples = (await channels(AbortSignal.any([signal, AbortSignal.timeout(10_000)]))).slice(0, 2);
        if (!samples.length) throw new Error('The portal returned no live channels to test.');
        samplesLoaded(samples.map((row, index) => row.name || `Sample channel ${index + 1}`));

        await runUserAgentTests(profiles, signal, {
            sampleCount: samples.length,
            resolveSample: async (profile, sampleIndex, attemptSignal) => {
                // Some portals mint a new short-lived token in each catalog response.
                const freshRows = await channels(attemptSignal);
                const original = samples[sampleIndex];
                const row = freshRows.find((candidate) => original.id != null && String(candidate.id) === String(original.id)) ?? freshRows[sampleIndex];
                if (!row) throw new Error('Sample channel is unavailable');
                let url = resolveStalkerStaticPlaybackUrl(row, row.cmd);
                if (!url) {
                    const link = await request({ type: 'itv', action: 'create_link', cmd: row.cmd, disable_ad: 0, download: 0 }, attemptSignal);
                    const command = link?.js?.cmd ?? link?.cmd;
                    if (!command) throw new Error('No playback link');
                    url = resolveStalkerPlaybackUrl(portalUrl, row.cmd, command);
                }
                const profilePlaylist = { ...playlist, userAgent: profile.value || undefined };
                return { url, headers: buildStalkerExternalPlaybackHeaders(profilePlaylist, authentication.token, url) };
            },
            probe: (sample, attemptSignal) => probeUserAgentMedia(bridge, sample, attemptSignal),
        }, publish);
    }
}
