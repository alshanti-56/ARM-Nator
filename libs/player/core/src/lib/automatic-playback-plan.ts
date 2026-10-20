import type { AutoPlaybackPreparation } from '@arm-nator/shared/interfaces';
import { VideoPlayer } from '@arm-nator/shared/interfaces';

export interface AutomaticNativeSupport {
    readonly embeddedMpv: boolean;
    readonly ksPlayer: boolean;
    readonly nativeHls?: boolean;
    /** Missing entries are unknown; only a known false excludes a codec. */
    readonly browserCodecs?: Readonly<Record<string, boolean>>;
}

export interface AutomaticPlaybackPlan {
    readonly engine: VideoPlayer | null;
    readonly reason: string;
}

/** Capability ranking excludes external applications and never probes the provider. */
export function rankAutomaticPlaybackEngines(
    media: Pick<AutoPlaybackPreparation, 'format' | 'container' | 'videoCodecs' | 'audioCodecs' | 'encrypted'>,
    support: AutomaticNativeSupport,
    remembered?: VideoPlayer,
): VideoPlayer[] {
    const engines: VideoPlayer[] = [];
    if (!media.encrypted) {
        if (support.embeddedMpv) engines.push(VideoPlayer.EmbeddedMpv);
        if (support.ksPlayer) engines.push(VideoPlayer.KsPlayer);
    }
    const browserCompatible = [...media.videoCodecs ?? [], ...media.audioCodecs ?? []]
        .every(codec => support.browserCodecs?.[codec] !== false);
    if (browserCompatible && media.container !== 'matroska') {
        if (media.format === 'hls' && support.nativeHls) engines.push(VideoPlayer.Html5Player);
        if (['hls', 'mpegts', 'dash', 'unknown'].includes(media.format)) engines.push(VideoPlayer.ArtPlayer);
        if (media.format === 'progressive' || media.format === 'unknown') engines.push(VideoPlayer.Html5Player);
    }
    return remembered && engines.includes(remembered)
        ? [remembered, ...engines.filter(engine => engine !== remembered)] : engines;
}

export function selectAutomaticPlaybackEngine(
    media: Pick<AutoPlaybackPreparation, 'format' | 'container' | 'videoCodecs' | 'audioCodecs' | 'encrypted'>,
    support: AutomaticNativeSupport,
): AutomaticPlaybackPlan {
    const engine = rankAutomaticPlaybackEngines(media, support)[0] ?? null;
    return { engine, reason: engine
        ? `Compatibility selection: ${engine} for ${media.container ?? media.format} media.`
        : 'No available player supports the known media capabilities.' };
}

export function shouldUseAutomaticNativeFallback(
    code: string,
    alreadyTried: boolean,
    nativeAvailable: boolean,
): boolean {
    return nativeAvailable && !alreadyTried &&
        ['unsupported-container', 'unsupported-codec', 'media-decode-error'].includes(code);
}
