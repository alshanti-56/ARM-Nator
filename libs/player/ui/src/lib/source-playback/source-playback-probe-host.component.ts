import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  viewChild,
} from "@angular/core";
import { SourcePlaybackProbeService } from "./source-playback-probe.service";
import { SilentMediaSession } from "./silent-media-session";
@Component({
  selector: "app-source-playback-probe-host",
  templateUrl: "./source-playback-probe-host.component.html",
  styleUrl: "./source-playback-probe-host.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourcePlaybackProbeHostComponent implements AfterViewInit {
  private readonly probe = inject(SourcePlaybackProbeService);
  private readonly media =
    viewChild.required<ElementRef<HTMLVideoElement>>("media");
  constructor() {
    inject(DestroyRef).onDestroy(() =>
      this.probe.setSessionFactory(() => null),
    );
  }
  ngAfterViewInit(): void {
    this.probe.setSessionFactory(
      () => new SilentMediaSession({ video: this.media().nativeElement }),
    );
  }
}
