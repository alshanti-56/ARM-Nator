import {
  Router,
  NavigationStart,
  NavigationCancel,
  NavigationError,
  NavigationEnd,
} from "@angular/router";
import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import {
  catalogueIdentityKey,
  playbackDiscoveryVersion,
} from "@arm-nator/shared/interfaces";
import type {
  DiscoveryVersion,
  ResolvedPortalPlayback,
  CatalogueItemIdentity,
  WorkDescriptor,
} from "@arm-nator/shared/interfaces";
import { PORTAL_DISCOVERY_ADAPTER } from "./portal-discovery-adapter";

@Injectable({ providedIn: "root" })
export class DiscoverySelectionService {
  private readonly adapter = inject(PORTAL_DISCOVERY_ADAPTER, {
    optional: true,
  });
  private readonly router = inject(Router, { optional: true });
  readonly playbackRequest = signal<{
    version: DiscoveryVersion;
    episode?: { seasonNumber: number; episodeNumber: number };
    navigationId?: number;
    url: string;
  } | null>(null);

  constructor() {
    const subscription = this.router?.events?.subscribe((event) => {
      const request = this.playbackRequest();
      if (!request) return;
      if (event instanceof NavigationStart) {
        if (event.url !== request.url) this.cancelPlaybackRequest();
        else this.playbackRequest.set({ ...request, navigationId: event.id });
      } else if (
        (event instanceof NavigationCancel ||
          event instanceof NavigationError) &&
        event.id === request.navigationId
      ) {
        this.cancelPlaybackRequest();
      } else if (
        event instanceof NavigationEnd &&
        event.urlAfterRedirects !== request.url
      ) {
        this.cancelPlaybackRequest();
      }
    });
    inject(DestroyRef).onDestroy(() => subscription?.unsubscribe());
  }

  requestPlayback(version: DiscoveryVersion, work?: WorkDescriptor): boolean {
    let episode: { seasonNumber: number; episodeNumber: number } | undefined;
    if (version.contentType === "series") {
      if (
        work?.kind !== "episode" ||
        !Number.isSafeInteger(work.seasonNumber) ||
        (work.seasonNumber ?? -1) < 0 ||
        !Number.isSafeInteger(work.episodeNumber) ||
        (work.episodeNumber ?? 0) < 1
      ) {
        this.error.set(
          "The current episode could not be identified for this version.",
        );
        return false;
      }
      episode = {
        seasonNumber: work.seasonNumber as number,
        episodeNumber: work.episodeNumber as number,
      };
    }
    const url = this.router
      ? this.router.serializeUrl(this.router.createUrlTree(version.navigation))
      : version.navigation.join("/");
    this.playbackRequest.set({ version, episode, url });
    return true;
  }

  cancelPlaybackRequest(): void {
    this.playbackRequest.set(null);
  }

  takePlaybackRequest(identity: CatalogueItemIdentity) {
    const request = this.playbackRequest();
    if (
      !request ||
      catalogueIdentityKey(request.version.identity) !==
        catalogueIdentityKey(identity)
    )
      return null;
    this.playbackRequest.set(null);
    return request;
  }

  private generation = 0;
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selection = signal<{
    versions: DiscoveryVersion[];
    selected: DiscoveryVersion;
  } | null>(null);

  select(
    versions: readonly DiscoveryVersion[],
    selected: DiscoveryVersion,
  ): void {
    const generation = ++this.generation;
    this.loading.set(false);
    this.error.set(null);
    this.selection.set({ versions: [...versions], selected });
    void this.adapter?.rememberVersions?.(versions).catch((error) => {
      if (generation === this.generation)
        this.error.set(
          `Version choices could not be remembered: ${String(error)}`,
        );
    });
  }

  async loadForPlayback(
    playback: ResolvedPortalPlayback | null,
  ): Promise<void> {
    const generation = ++this.generation;
    const current = playback && playbackDiscoveryVersion(playback);
    const previous = this.matches(playback) ? this.selection() : null;
    this.error.set(null);
    this.selection.set(
      current ? (previous ?? { versions: [current], selected: current }) : null,
    );
    this.loading.set(!!current && !!this.adapter?.versions);
    if (!current || !playback || !this.adapter?.versions) return;
    try {
      const versions = await this.adapter.versions(
        playback,
        previous?.versions ?? [],
      );
      if (generation !== this.generation) return;
      const selected =
        versions.find(
          (v) =>
            catalogueIdentityKey(v.identity) ===
            catalogueIdentityKey(current.identity),
        ) ?? current;
      this.selection.set({
        versions: versions.length ? versions : [current],
        selected,
      });
    } catch (error) {
      if (generation === this.generation)
        this.error.set(
          `Available versions could not be checked: ${String(error)}`,
        );
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  matches(playback: ResolvedPortalPlayback | null | undefined): boolean {
    const selected = this.selection()?.selected;
    const identity =
      playback &&
      (selected?.contentType === "series"
        ? playback.seriesIdentity
        : playback.itemIdentity);
    return (
      !!selected &&
      !!identity &&
      catalogueIdentityKey(selected.identity) === catalogueIdentityKey(identity)
    );
  }
}
