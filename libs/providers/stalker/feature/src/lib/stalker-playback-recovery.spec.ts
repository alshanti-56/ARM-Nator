import type { ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';
import { getPlaybackContext } from '@arm-nator/player/core';
import { createStalkerPlaybackRecoveryContext } from './stalker-playback-recovery';

describe('createStalkerPlaybackRecoveryContext', () => {
    it('resolves data while preserving the original source identity', async () => {
        const signal = new AbortController().signal;
        const original: ResolvedPortalPlayback = {
            streamUrl: 'http://portal.test/temporary/old',
            title: 'Episode 2',
            recovery: {
                accountRef: 'playlist-1',
                providerLinkRenewable: true,
            },
            itemIdentity: {
                sourceType: 'stalker',
                playlistId: 'playlist-1',
                contentKind: 'episode',
                providerItemId: 'series-10:episode-2',
            },
            contentInfo: {
                playlistId: 'playlist-1',
                contentType: 'episode',
                contentXtreamId: 2,
                seriesXtreamId: 10,
                seasonNumber: 1,
                episodeNumber: 2,
            },
            work: { kind: 'episode', title: 'Episode 2', episodeNumber: 2 },
        };
        const resolver = jest.fn().mockResolvedValue({
            streamUrl: 'http://portal.test/temporary/new',
            title: 'Changed title',
            itemIdentity: { sourceType: 'stalker', providerItemId: 'wrong' },
            contentInfo: { playlistId: 'wrong', contentType: 'vod' },
            work: { kind: 'movie', title: 'wrong' },
        });
        const context = createStalkerPlaybackRecoveryContext(
            original,
            resolver
        );
        expect(getPlaybackContext(original)?.resolvePlayback).toBe(
            context.resolvePlayback
        );

        const resolved = await context.resolvePlayback?.({
            signal,
            reason: 'media-auth-failure',
        });

        expect(resolver).toHaveBeenCalledWith({
            signal,
            reason: 'media-auth-failure',
        });
        expect(resolved?.streamUrl).toBe('http://portal.test/temporary/new');
        expect(resolved?.itemIdentity).toBe(original.itemIdentity);
        expect(resolved?.contentInfo).toBe(original.contentInfo);
        expect(resolved?.work).toBe(original.work);
    });

    it('keeps static metadata but does not expose a renewal resolver', () => {
        const original: ResolvedPortalPlayback = {
            streamUrl: 'https://static.example/movie.mp4',
            title: 'Movie',
            recovery: {
                accountRef: 'playlist-1',
                savedHeaders: { 'User-Agent': 'Custom UA' },
                defaultHeaders: { 'User-Agent': 'MAG' },
            },
        };
        const context = createStalkerPlaybackRecoveryContext(
            original,
            jest.fn()
        );

        expect(context.resolvePlayback).toBeUndefined();
        expect(getPlaybackContext(original)).toBeUndefined();
        expect(original.recovery).toMatchObject({
            accountRef: 'playlist-1',
            savedHeaders: { 'User-Agent': 'Custom UA' },
            defaultHeaders: { 'User-Agent': 'MAG' },
        });
    });

    it('keeps refreshed identity fields when the original omitted them', async () => {
        const refreshed = {
            streamUrl: 'https://portal.example/new.m3u8',
            itemIdentity: {
                sourceType: 'stalker' as const,
                playlistId: 'playlist-1',
                contentKind: 'vod' as const,
                providerItemId: 'movie-2',
            },
            contentInfo: {
                playlistId: 'playlist-1',
                contentType: 'vod' as const,
                contentXtreamId: 2,
            },
        };
        const context = createStalkerPlaybackRecoveryContext(
            {
                streamUrl: 'https://portal.example/old.m3u8',
                recovery: {
                    accountRef: 'playlist-1',
                    providerLinkRenewable: true,
                },
            },
            jest.fn().mockResolvedValue(refreshed)
        );

        await expect(
            context.resolvePlayback?.({
                signal: new AbortController().signal,
                reason: 'manual-retry',
            })
        ).resolves.toMatchObject({
            itemIdentity: refreshed.itemIdentity,
            contentInfo: refreshed.contentInfo,
        });
    });

    it('does not start or return a resolution after cancellation', async () => {
        const controller = new AbortController();
        const resolver = jest.fn().mockResolvedValue({
            streamUrl: 'http://portal.test/temporary/new',
            title: 'Episode',
        });
        const context = createStalkerPlaybackRecoveryContext(
            {
                streamUrl: 'http://portal.test/temporary/old',
                title: 'Episode',
                recovery: {
                    accountRef: 'playlist-1',
                    providerLinkRenewable: true,
                },
            },
            resolver
        );
        controller.abort();

        await expect(
            context.resolvePlayback?.({
                signal: controller.signal,
                reason: 'manual-retry',
            })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(resolver).not.toHaveBeenCalled();
    });
});
