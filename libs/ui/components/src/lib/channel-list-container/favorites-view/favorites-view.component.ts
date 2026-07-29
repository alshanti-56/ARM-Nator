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
import { MatDialog } from "@angular/material/dialog";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule, MatMenuTrigger } from "@angular/material/menu";
import { TranslatePipe } from "@ngx-translate/core";
import { Channel } from "@arm-nator/shared/interfaces";

import { ChannelDetailsDialogComponent } from "../channel-details-dialog/channel-details-dialog.component";
import { resolveChannelLogo } from "../channel-logo-fallback.util";
import { ChannelListItemComponent } from "../channel-list-item/channel-list-item.component";

@Component({
  selector: "app-favorites-view",
  templateUrl: "./favorites-view.component.html",
  styleUrls: ["./favorites-view.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ChannelListItemComponent,
    DragDropModule,
    MatIconModule,
    MatMenuModule,
    TranslatePipe,
  ],
})
export class FavoritesViewComponent {
  private readonly dialog = inject(MatDialog);

  readonly contextMenuTrigger =
    viewChild.required<MatMenuTrigger>("contextMenuTrigger");

  /** Favorite channels */
  readonly favorites = input.required<Channel[]>();
  readonly searchTerm = input("");
  readonly channelIconMap = input.required<Map<string, string>>();

  /** Progress tick to trigger progress recalculation */
  readonly progressTick = input.required<number>();
  readonly openOnDoubleClick = input(false);

  /** Currently active channel URL */
  readonly activeChannelUrl = input<string | undefined>();

  /** Emits when a channel is selected */
  readonly channelSelected = output<Channel>();
  readonly channelPlaybackRequested = output<Channel>();

  /** Emits when favorite is toggled (removed) */
  readonly favoriteToggled = output<{
    channel: Channel;
    event: MouseEvent;
  }>();

  /** Emits when favorites order changes via drag-drop */
  readonly favoritesReordered = output<string[]>();

  readonly contextMenuChannel = signal<Channel | null>(null);
  readonly contextMenuPosition = signal({
    x: "0px",
    y: "0px",
  });

  readonly hasSearchTerm = computed(() => this.searchTerm().trim().length > 0);
  readonly filteredFavorites = computed(() => {
    const favorites = this.favorites();
    const term = this.searchTerm().trim().toLowerCase();

    if (!term) {
      return favorites;
    }

    return favorites.filter((channel) =>
      `${channel.name ?? ""} ${channel.group?.title ?? ""}`
        .toLowerCase()
        .includes(term),
    );
  });

  /** Resolves the channel logo. Called per visible row from the template. */
  getLogoForChannel(channel: Channel): string {
    return resolveChannelLogo(channel, this.channelIconMap());
  }

  trackByFn(_: number, channel: Channel): string {
    return channel?.id;
  }

  onChannelClick(channel: Channel): void {
    this.channelSelected.emit(channel);
  }

  onChannelActivate(channel: Channel): void {
    if (this.openOnDoubleClick()) {
      this.channelPlaybackRequested.emit(channel);
    }
  }

  onFavoriteToggle(channel: Channel, event: MouseEvent): void {
    this.favoriteToggled.emit({ channel, event });
  }

  onChannelContextMenu(channel: Channel, event: MouseEvent): void {
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

  openChannelDetails(): void {
    const channel = this.contextMenuChannel();
    if (!channel) {
      return;
    }

    this.contextMenuTrigger().closeMenu();
    this.dialog.open(ChannelDetailsDialogComponent, {
      data: channel,
      maxWidth: "720px",
      width: "calc(100vw - 32px)",
    });
  }

  onDrop(event: CdkDragDrop<Channel[]>): void {
    if (this.hasSearchTerm()) {
      return;
    }

    const favorites = [...this.favorites()];
    moveItemInArray(favorites, event.previousIndex, event.currentIndex);
    this.favoritesReordered.emit(favorites.map((item) => item.url));
  }
}
