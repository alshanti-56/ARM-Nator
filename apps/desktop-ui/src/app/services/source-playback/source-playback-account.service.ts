import {
  StalkerAccountInfoService,
  type StalkerAccountSnapshot,
} from "@arm-nator/providers/stalker/data-access";
import { Injectable, inject, Injector } from "@angular/core";
import { firstValueFrom } from "rxjs";
import {
  PlaylistsService,
  SourcePlaybackRepositoryService,
} from "@arm-nator/services";
import {
  SOURCE_PLAYBACK_POLICY as P,
  getPlaylistSourceType,
  type SourceAccountSnapshot,
} from "@arm-nator/shared/interfaces";
import {
  XtreamApiService,
  xtreamSourceRequest,
} from "@arm-nator/providers/xtream/data-access";
import { sourceDeadline } from "./source-playback-check-runner";
function reportedCount(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function mapXtreamSourceAccount(
  payload: unknown,
  checkedAt = Date.now(),
): SourceAccountSnapshot {
  const user =
    (payload as { user_info?: Record<string, unknown> } | null)?.user_info ??
    {};
  const raw = user["exp_date"];
  const seconds = reportedCount(raw);
  const expiry = seconds && seconds <= 8640000000000 ? seconds * 1000 : null;
  const none =
    typeof raw === "string" &&
    ["never", "unlimited", "no expiry", "no expiration"].includes(
      raw.trim().toLowerCase(),
    );
  return {
    checkedAt,
    expiresAt: expiry,
    expiryKind: expiry ? "date" : none ? "none" : "unknown",
    activeConnections: reportedCount(user["active_cons"]),
    maxConnections: reportedCount(user["max_connections"]),
  };
}
export function sourceAccountAtCapacity(
  account: SourceAccountSnapshot | null,
): boolean {
  return (
    account?.activeConnections !== null &&
    account?.activeConnections !== undefined &&
    account.maxConnections !== null &&
    account.maxConnections > 0 &&
    account.activeConnections >= account.maxConnections
  );
}
export function mapStalkerSourceAccount(
  value: StalkerAccountSnapshot,
  checkedAt = Date.now(),
): SourceAccountSnapshot {
  const seconds = value.expireDate;
  return {
    checkedAt,
    expiresAt:
      typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : null,
    expiryKind:
      typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
        ? "date"
        : "unknown",
    activeConnections: null,
    maxConnections: null,
  };
}
@Injectable({ providedIn: "root" })
export class SourcePlaybackAccountService {
  private readonly sourceInjector = inject(Injector);
  private readonly playlists = inject(PlaylistsService);
  private readonly api = inject(XtreamApiService);
  private readonly repository = inject(SourcePlaybackRepositoryService);
  async read(
    sourceId: string,
    revision: string,
    parent: AbortSignal,
  ): Promise<SourceAccountSnapshot | null> {
    const deadline = sourceDeadline(parent, P.accountMs);
    let snapshot: SourceAccountSnapshot | null;
    try {
      const source = await firstValueFrom(
        this.playlists.getPlaylistById(sourceId),
      );
      deadline.signal.throwIfAborted();
      if (source && getPlaylistSourceType(source) === "stalker") {
        const account = await this.sourceInjector
          .get(StalkerAccountInfoService)
          .fetchAccountInfo(source, { signal: deadline.signal });
        snapshot = account ? mapStalkerSourceAccount(account) : null;
      } else {
        if (
          !source ||
          getPlaylistSourceType(source) !== "xtream" ||
          !source.serverUrl ||
          !source.username ||
          !source.password
        )
          return null;
        const payload = await xtreamSourceRequest(
          this.api,
          deadline.signal,
          (options) =>
            this.api.getAccountInfo(
              {
                serverUrl: source.serverUrl!,
                username: source.username!,
                password: source.password!,
              },
              options,
            ),
        );
        snapshot = mapXtreamSourceAccount(payload);
      }
    } catch (error) {
      parent.throwIfAborted();
      if (
        (error as { status?: number })?.status === 429 ||
        (error as { retryAfterMs?: number })?.retryAfterMs
      )
        throw error;
      return null;
    } finally {
      deadline.clear();
    }
    if (snapshot)
      await this.repository.writeAccount(sourceId, revision, snapshot);
    return snapshot;
  }
}
