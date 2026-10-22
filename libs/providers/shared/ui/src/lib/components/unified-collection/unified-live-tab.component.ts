import { withPlaybackIntent } from "@arm-nator/player/core";
import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
    ResolvedLiveCollectionDetail,
    StreamResolverService,
    UnifiedRecentDataService,
} from '@arm-nator/providers/shared/data-access';
import {
    DEFAULT_FAVORITES_CHANNEL_SORT_MODE,
    FavoritesChannelSortMode,
    matchesOpenLiveCollectionItem,
    OpenLiveCollectionItemState,
    PORTAL_PLAYER,
    UnifiedCollectionItem,
    UnifiedFavoriteChannel,
} from '@arm-nator/providers/shared/util';
import { ResizableDirective } from '@arm-nator/ui/components';
import { SettingsStore } from '@arm-nator/services';
import { GlobalFavoritesListComponent } from '../global-favorites-list/global-favorites-list.component';
import { PortalEmptyStateComponent } from '../portal-empty-state/portal-empty-state.component';

@Component({
  selector: "app-unified-live-tab",
  templateUrl: "./unified-live-tab.component.html",
  styleUrl: "./unified-live-tab.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GlobalFavoritesListComponent,
    PortalEmptyStateComponent,
    ResizableDirective,
    TranslatePipe,
  ],
})
export class UnifiedLiveTabComponent {
  readonly items = input.required<UnifiedCollectionItem[]>();
  readonly mode = input<"favorites" | "recent">("favorites");
  readonly searchTerm = input("");
  readonly autoOpenItem = input<OpenLiveCollectionItemState | null>(null);
  readonly favoriteUids = input<ReadonlySet<string>>(new Set<string>());
  readonly sortMode = input<FavoritesChannelSortMode>(
    DEFAULT_FAVORITES_CHANNEL_SORT_MODE,
  );
  readonly isSidebarCollapsed = input(false);

  readonly removeItem = output<UnifiedCollectionItem>();
  readonly favoriteToggled = output<UnifiedCollectionItem>();
  readonly reorderItems = output<UnifiedCollectionItem[]>();
  readonly itemPlayed = output<UnifiedCollectionItem>();
  readonly autoOpenHandled = output<void>();

  private readonly streamResolver = inject(StreamResolverService);
  private readonly recentData = inject(UnifiedRecentDataService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly portalPlayer = inject(PORTAL_PLAYER);

  readonly activeDetail = signal<ResolvedLiveCollectionDetail | null>(null);
  readonly activeUid = signal<string | null>(null);
  readonly isSelecting = signal(false);
  readonly progressTick = signal(0);
  readonly isEmbeddedPlayer = computed(() =>
    this.portalPlayer.isEmbeddedPlayer(true),
  );
  readonly shouldUseInlinePlayer = computed(() => this.isEmbeddedPlayer());
  readonly channelsForList = computed((): UnifiedFavoriteChannel[] =>
    this.items().map((item) => ({
      uid: item.uid,
      name: item.name,
      logo: item.logo ?? null,
      sourceType: item.sourceType,
      playlistId: item.playlistId,
      playlistName: item.playlistName,
      xtreamId: item.xtreamId,
      tvgId: item.tvgId,
      addedAt: item.addedAt ?? new Date(0).toISOString(),
      position: item.position ?? 0,
      contentId: item.contentId,
    })),
  );

  private selectionRequestId = 0;

  constructor() {
    effect(() => {
      const target = this.autoOpenItem();
      const items = this.items();
      if (!target || items.length === 0) return;

      const item = items.find((candidate) =>
        matchesOpenLiveCollectionItem(candidate, target),
      );
      if (!item) return;
      if (this.activeUid() === item.uid && this.activeDetail()) {
        this.autoOpenHandled.emit();
        return;
      }
      if (!this.isSelecting()) void this.activateItem(item, true);
    });
  }

  async onChannelSelected(channel: UnifiedFavoriteChannel): Promise<void> {
    const item = this.findItem(channel.uid);
    if (item) await this.activateItem(item);
  }

  async onChannelPlaybackRequested(
    channel: UnifiedFavoriteChannel,
  ): Promise<void> {
    const item = this.findItem(channel.uid);
    if (item) await this.activateItem(item, false, true);
  }

  onFavoriteToggled(channel: UnifiedFavoriteChannel): void {
    const item = this.findItem(channel.uid);
    if (!item) return;
    if (this.mode() === "favorites") this.removeItem.emit(item);
    else this.favoriteToggled.emit(item);
  }

  onRemoveRequested(channel: UnifiedFavoriteChannel): void {
    const item = this.findItem(channel.uid);
    if (item) this.removeItem.emit(item);
  }

  onReorder(channels: UnifiedFavoriteChannel[]): void {
    this.reorderItems.emit(
      channels
        .map((channel) => this.findItem(channel.uid))
        .filter((item): item is UnifiedCollectionItem => Boolean(item)),
    );
  }

  onClose(): void {
    this.selectionRequestId += 1;
    this.isSelecting.set(false);
    this.activeDetail.set(null);
    this.activeUid.set(null);
  }

  private async activateItem(
    item: UnifiedCollectionItem,
    isAutoOpen = false,
    startPlayback = false,
  ): Promise<void> {
    return withPlaybackIntent(this.portalPlayer, async () => {
      const requestId = ++this.selectionRequestId;
      this.activeUid.set(item.uid);
      this.activeDetail.set(null);
      this.isSelecting.set(true);

      try {
        const detail = await this.streamResolver.resolveLiveDetail(item);
        if (requestId !== this.selectionRequestId) return;
        this.activeDetail.set(detail);

        if (
          this.shouldUseInlinePlayer() ||
          this.shouldOpenExternalPlayback(detail, startPlayback)
        ) {
          const items = this.items();
          const index = items.findIndex(
            (candidate) => candidate.uid === item.uid,
          );
          await this.portalPlayer.openResolvedPlayback(detail.playback, true, {
            canPrevious: index > 0,
            canNext: index >= 0 && index < items.length - 1,
            onPrevious: () => {
              const previous = items[index - 1];
              if (previous) void this.activateItem(previous, false, true);
            },
            onNext: () => {
              const next = items[index + 1];
              if (next) void this.activateItem(next, false, true);
            },
          });
        }

        try {
          const updatedItem = await this.recentData.recordLivePlayback(item);
          if (requestId === this.selectionRequestId) {
            this.itemPlayed.emit(updatedItem);
          }
        } catch {
          // Playback remains available when history persistence fails.
        }

        if (isAutoOpen) this.autoOpenHandled.emit();
      } catch {
        if (requestId === this.selectionRequestId) {
          this.activeDetail.set(null);
          this.activeUid.set(null);
        }
      } finally {
        if (requestId === this.selectionRequestId) {
          this.isSelecting.set(false);
        }
      }
    });
  }

  private shouldOpenExternalPlayback(
    detail: ResolvedLiveCollectionDetail,
    startPlayback: boolean,
  ): boolean {
    if (this.portalPlayer.isEmbeddedPlayer(true)) {
      return false;
    }
    return !this.settingsStore.openStreamOnDoubleClick() || startPlayback;
  }

  private findItem(uid: string): UnifiedCollectionItem | undefined {
    return this.items().find((item) => item.uid === uid);
  }
}
