import {
  CdkDragDrop,
  DragDropModule,
  moveItemInArray,
} from "@angular/cdk/drag-drop";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule, MatMenuTrigger } from "@angular/material/menu";
import { ChannelListItemComponent } from "@arm-nator/ui/components";
import { SettingsStore } from "@arm-nator/services";
import {
  DEFAULT_FAVORITES_CHANNEL_SORT_MODE,
  FavoritesChannelSortMode,
  sortFavoriteChannelItems,
  UnifiedFavoriteChannel,
} from "@arm-nator/providers/shared/util";
import { TranslatePipe } from "@ngx-translate/core";

export type EnrichedUnifiedFavorite = UnifiedFavoriteChannel;

export type GlobalFavoritesListMode = "favorites" | "recent";

@Component({
  selector: "app-global-favorites-list",
  templateUrl: "./global-favorites-list.component.html",
  styleUrl: "./global-favorites-list.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ChannelListItemComponent,
    DragDropModule,
    MatIconModule,
    MatMenuModule,
    TranslatePipe,
  ],
})
export class GlobalFavoritesListComponent {
  private readonly settingsStore = inject(SettingsStore);

  readonly contextMenuTrigger =
    viewChild.required<MatMenuTrigger>("contextMenuTrigger");
  readonly openStreamOnDoubleClick = computed(() =>
    this.settingsStore.openStreamOnDoubleClick(),
  );

  readonly channels = input.required<UnifiedFavoriteChannel[]>();
  readonly mode = input<GlobalFavoritesListMode>("favorites");
  readonly favoriteUids = input<ReadonlySet<string>>(new Set<string>());
  readonly progressTick = input<number>(0);
  readonly activeUid = input<string | null>(null);
  readonly searchTermInput = input("");
  readonly draggable = input(true);
  readonly sortMode = input<FavoritesChannelSortMode>(
    DEFAULT_FAVORITES_CHANNEL_SORT_MODE,
  );

  readonly channelSelected = output<UnifiedFavoriteChannel>();
  readonly playbackRequested = output<UnifiedFavoriteChannel>();
  readonly channelsReordered = output<UnifiedFavoriteChannel[]>();
  readonly favoriteToggled = output<UnifiedFavoriteChannel>();
  readonly removeRequested = output<UnifiedFavoriteChannel>();

  readonly contextMenuChannel = signal<EnrichedUnifiedFavorite | null>(null);
  readonly contextMenuPosition = signal({
    x: "0px",
    y: "0px",
  });

  readonly isCustomSort = computed(() => this.sortMode() === "custom");
  readonly canDragDrop = computed(
    () =>
      this.mode() === "favorites" &&
      this.draggable() &&
      this.isCustomSort() &&
      !this.hasSearchTerm(),
  );

  readonly hasSearchTerm = computed(
    () => this.searchTermInput().trim().length > 0,
  );

  readonly enrichedChannels = computed((): EnrichedUnifiedFavorite[] => {
    const channels = this.channels();
    const term = this.searchTermInput().trim().toLowerCase();
    this.progressTick();

    const filtered = term
      ? channels.filter((ch) => ch.name.toLowerCase().includes(term))
      : channels;

    const sorted =
      this.mode() === "favorites"
        ? sortFavoriteChannelItems(filtered, this.sortMode(), {
            getName: (ch) => ch.name,
            getAddedAt: (ch) => ch.addedAt,
          })
        : filtered;

    return [...sorted];
  });

  onChannelClick(channel: UnifiedFavoriteChannel): void {
    this.channelSelected.emit(channel);
  }

  onChannelActivate(channel: UnifiedFavoriteChannel): void {
    if (this.openStreamOnDoubleClick()) {
      this.playbackRequested.emit(channel);
    }
  }

  onFavoriteToggled(channel: UnifiedFavoriteChannel): void {
    this.favoriteToggled.emit(channel);
  }

  onChannelContextMenu(
    channel: EnrichedUnifiedFavorite,
    event: MouseEvent,
  ): void {
    this.contextMenuChannel.set(channel);
    this.contextMenuPosition.set({
      x: `${event.clientX}px`,
      y: `${event.clientY}px`,
    });

    const trigger = this.contextMenuTrigger();
    if (trigger.menuOpen) {
      trigger.closeMenu();
    }

    queueMicrotask(() => {
      this.contextMenuTrigger().openMenu();
    });
  }

  hasChannelContextMenu(): boolean {
    return this.mode() === "recent";
  }

  removeContextMenuChannel(): void {
    const channel = this.contextMenuChannel();
    if (!channel) {
      return;
    }

    this.contextMenuTrigger().closeMenu();
    this.removeRequested.emit(channel);
  }

  isChannelFavorite(channel: UnifiedFavoriteChannel): boolean {
    return this.mode() === "favorites" || this.favoriteUids().has(channel.uid);
  }

  onDrop(event: CdkDragDrop<EnrichedUnifiedFavorite[]>): void {
    if (!this.canDragDrop()) {
      return;
    }

    const list = [...this.channels()];
    moveItemInArray(list, event.previousIndex, event.currentIndex);
    this.channelsReordered.emit(list);
  }

  trackByUid(_: number, ch: EnrichedUnifiedFavorite): string {
    return ch.uid;
  }

}
