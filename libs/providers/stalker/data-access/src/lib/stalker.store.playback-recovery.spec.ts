import { TestBed } from '@angular/core/testing';
import { DataService, TmdbEnrichmentService } from '@arm-nator/services';
import { PlaylistMeta, StalkerPortalActions } from '@arm-nator/shared/interfaces';
import { StalkerStore } from './stalker.store';

const PLAYLIST = {
    _id: 'playlist-stalker',
    title: 'Stalker',
    count: 0,
    autoRefresh: false,
    importDate: '2026-04-14T00:00:00.000Z',
    portalUrl: 'http://portal.example/stalker_portal/server/load.php',
    macAddress: '00:1A:79:00:00:01',
    isFullStalkerPortal: false,
} as PlaylistMeta;

describe('StalkerStore playback recovery', () => {
    let store: StalkerStore;
    let sendIpcEvent: jest.Mock;

    beforeEach(() => {
        sendIpcEvent = jest.fn().mockResolvedValue({
            js: { cmd: 'ffmpeg http://cdn.example/temporary/channel.m3u8' },
        });
        TestBed.configureTestingModule({
            providers: [
                StalkerStore,
                { provide: DataService, useValue: { sendIpcEvent } },
                { provide: TmdbEnrichmentService, useValue: {} },
            ],
        });
        store = TestBed.inject(StalkerStore);
        store.setCurrentPlaylist(PLAYLIST);
    });

    it('returns a create_link recovery profile for a temporary live URL', async () => {
        const playback = await store.resolveItvPlayback({
            id: 'channel-1',
            cmd: 'ffrt3 http://cdn.example/live/channel.m3u8',
            use_http_tmp_link: '1',
        });

        expect(sendIpcEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                params: expect.objectContaining({
                    action: StalkerPortalActions.CreateLink,
                }),
            })
        );
        expect(playback.recovery).toEqual(
            expect.objectContaining({
                providerLinkRenewable: true,
                accountRef: PLAYLIST._id,
            })
        );
        expect(playback.recovery?.portalCredentialsAvailable).toBeUndefined();
        expect(playback.requestPolicy).toEqual({
            accountRef: PLAYLIST._id,
            loginCookies: true,
            portalCredentials: true,
        });
    });

    it('does not claim a static live URL can be renewed', async () => {
        const playback = await store.resolveItvPlayback({
            id: 'channel-static',
            cmd: 'ffrt3 https://cdn.example/live/channel.m3u8',
            use_http_tmp_link: '0',
            use_load_balancing: '0',
        });

        expect(sendIpcEvent).not.toHaveBeenCalled();
        expect(playback.recovery).toEqual(
            expect.objectContaining({
                accountRef: PLAYLIST._id,
                defaultHeaders: expect.any(Object),
            })
        );
        expect(playback.recovery?.providerLinkRenewable).toBeUndefined();
    });

    it('does not issue a live create_link request after cancellation', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            store.resolveItvPlayback(
                {
                    id: 'channel-cancelled',
                    cmd: 'ffrt3 http://cdn.example/live/channel.m3u8',
                    use_http_tmp_link: '1',
                },
                false,
                controller.signal
            )
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(sendIpcEvent).not.toHaveBeenCalled();
    });
});
