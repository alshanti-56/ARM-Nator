import type { AutomaticNativeSupport } from './automatic-playback-plan';

type SupportProbe = (() => Promise<{ supported: boolean } | null>) | undefined;

/** Optional native capabilities must not indefinitely block browser playback. */
export async function queryAutomaticNativeSupport(
    probes: { embeddedMpv?: SupportProbe; ksPlayer?: SupportProbe },
    timeoutMs = 5000,
): Promise<AutomaticNativeSupport> {
    const query = async (probe: SupportProbe): Promise<boolean> => {
        if (!probe) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                Promise.resolve().then(probe).then(result => result?.supported === true),
                new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
            ]);
        } catch {
            return false;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    };
    const [embeddedMpv, ksPlayer] = await Promise.all([query(probes.embeddedMpv), query(probes.ksPlayer)]);
    return { embeddedMpv, ksPlayer };
}
