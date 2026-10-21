import { Injectable, inject } from "@angular/core";
import { DataService } from "@arm-nator/services";
import {
  isFullStalkerPortalPlaylist,
  type PlaylistMeta,
} from "@arm-nator/shared/interfaces";
import { StalkerPortalRepairService } from "./stalker-portal-repair.service";
import {
  StalkerAuthApi,
  type StalkerAuthenticationResult,
} from "./stalker-auth.api";
import { getStalkerPortalIdentityFromPlaylist } from "./stalker-identity.utils";
import { abortableStalkerRequest } from "./abortable-stalker-request";
import type { createLogger } from "@arm-nator/providers/shared/util";
export interface StalkerSourceContext {
  playlist: PlaylistMeta;
  token: string | undefined;
  authentication: StalkerAuthenticationResult | null;
  request<T = unknown>(params: Record<string, string | number>): Promise<T>;
}
/** A repair wait owns no request; aborting it must not cancel someone else's repair. */
export async function waitForSourceRepair(
  pending: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        Object.assign(Error("Portal request cancelled"), {
          name: "AbortError",
        }),
      );
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([pending, cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
@Injectable({ providedIn: "root" })
export class StalkerSourcePlaybackContextService {
  private readonly data = inject(DataService);
  private readonly repair = inject(StalkerPortalRepairService);
  async run<T>(
    source: PlaylistMeta,
    signal: AbortSignal,
    operation: (context: StalkerSourceContext) => Promise<T>,
    profile = false,
  ): Promise<T> {
    await waitForSourceRepair(
      this.repair.waitForPendingRepair(source._id),
      signal,
    );
    const playlist = this.repair.applyOverride(source);
    signal.throwIfAborted();
    if (!playlist.portalUrl || !playlist.macAddress)
      throw Error("Portal identity unavailable");
    const pending = new Set<Promise<unknown>>();
    const data = {
      sendIpcEvent: <R>(type: string, payload?: unknown): Promise<R> => {
        const run = Promise.resolve().then(() =>
          this.data.sendIpcEvent<R>(type, payload),
        );
        pending.add(run);
        void run.then(
          () => pending.delete(run),
          () => pending.delete(run),
        );
        return run;
      },
    } as DataService;
    try {
      const auth = new StalkerAuthApi(data, {
        debug: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as ReturnType<typeof createLogger>);
      const authentication = isFullStalkerPortalPlaylist(playlist)
        ? await auth.authenticate(
            playlist.portalUrl,
            playlist.macAddress,
            getStalkerPortalIdentityFromPlaylist(playlist),
            {
              storedToken: playlist.stalkerToken,
              credentials: {
                username: playlist.username,
                password: playlist.password,
              },
              signal,
              skipProfileWhenReused: !profile,
            },
          )
        : null;
      signal.throwIfAborted();
      const context: StalkerSourceContext = {
        playlist,
        authentication,
        token: authentication?.token,
        request: async <R>(
          params: Record<string, string | number>,
        ): Promise<R> => {
          signal.throwIfAborted();
          const response = await abortableStalkerRequest<R>(
            data,
            {
              url: playlist.portalUrl!,
              macAddress: playlist.macAddress!,
              token: context.token,
              serialNumber: playlist.stalkerSerialNumber,
              accountRef: playlist._id,
              params: { ...params, JsHttpRequest: "1-xml" },
            },
            signal,
          );
          signal.throwIfAborted();
          const refreshed = (response as { js?: { token?: unknown } } | null)
            ?.js?.token;
          if (typeof refreshed === "string" && refreshed)
            context.token = refreshed;
          return response;
        },
      };
      return await operation(context);
    } finally {
      while (pending.size) await Promise.allSettled([...pending]);
    }
  }
}
