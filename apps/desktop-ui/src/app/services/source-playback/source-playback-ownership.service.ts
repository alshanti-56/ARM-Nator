import { DestroyRef, Injectable, inject } from "@angular/core";
import {
  PlaybackResourceService,
  WorkspacePlayerStateService,
} from "@arm-nator/player/ui";
import { ExternalPlaybackService } from "../external-playback.service";
import { sourcePlaybackOccupied } from "./source-playback-occupancy";
@Injectable({ providedIn: "root" })
export class SourcePlaybackOwnershipService {
  private readonly resources = inject(PlaybackResourceService);
  private readonly player = inject(WorkspacePlayerStateService);
  private readonly external = inject(ExternalPlaybackService);
  private stop: (() => void) | null = null;
  start(): () => void {
    this.stop ??= this.resources.registerBlocker(() =>
      sourcePlaybackOccupied({
        playback: !!this.player.playback(),
        stopped: this.player.stopped(),
        preparing: this.player.automaticPreparing(),
        recovering: this.player.recoveryBusy(),
        youtube: !!this.player.youtube(),
        external: this.external.activeSession(),
      }),
    );
    return () => {
      this.stop?.();
      this.stop = null;
    };
  }
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stop?.();
      this.stop = null;
    });
  }
}
