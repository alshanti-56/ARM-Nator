import { DragDropModule } from "@angular/cdk/drag-drop";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { MatIcon } from "@angular/material/icon";
import { SettingsStore } from "@arm-nator/services";
import { applyChannelNameStrip } from "@arm-nator/providers/shared/util";

@Component({
  selector: "app-channel-list-item",
  styleUrls: ["./channel-list-item.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./channel-list-item.component.html",
  imports: [DragDropModule, MatIcon],
})
export class ChannelListItemComponent {
  private readonly logoFailed = signal(false);
  private readonly settingsStore = inject(SettingsStore);

  readonly isDraggable = input(false);
  readonly logo = input<string | null | undefined>("");
  readonly name = input("");
  readonly displayName = computed(() =>
    applyChannelNameStrip(
      this.name(),
      this.settingsStore.stripCountryPrefix?.(),
    ),
  );
  readonly showFavoriteButton = input(false);
  readonly showAuxActionButton = input(false);
  readonly showProgramInfoButton = input(true);
  readonly showDetailsContextMenu = input(false);
  readonly isFavorite = input(false);
  readonly selected = input(false);
  readonly isRadio = input(false);
  /** Progress percentage pre-computed by parent for performance */
  readonly progressPercentage = input(0);
  readonly auxActionIcon = input("delete");
  readonly auxActionTooltip = input("");

  readonly clicked = output<void>();
  readonly activated = output<void>();
  readonly favoriteToggled = output<MouseEvent>();
  readonly auxActionClicked = output<MouseEvent>();
  readonly contextMenuRequested = output<MouseEvent>();

  constructor() {
    effect(() => {
      this.logo();
      this.logoFailed.set(false);
    });
  }

  onFavoriteClick(event: MouseEvent): void {
    event.stopPropagation();
    this.favoriteToggled.emit(event);
  }

  onAuxActionClick(event: MouseEvent): void {
    event.stopPropagation();
    this.auxActionClicked.emit(event);
  }

  onClick(event?: MouseEvent): void {
    if ((event?.detail ?? 1) > 1) {
      return;
    }

    this.clicked.emit();
  }

  onDoubleClick(): void {
    this.activated.emit();
  }

  onContextMenu(event: MouseEvent): void {
    if (!this.showDetailsContextMenu()) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.contextMenuRequested.emit(event);
  }

  showLogoFallback(): boolean {
    return !this.logo() || this.logoFailed();
  }

  onLogoError(event: Event): void {
    this.logoFailed.set(true);
    (event.target as HTMLImageElement | null)?.style.setProperty(
      "display",
      "none",
    );
  }
}
