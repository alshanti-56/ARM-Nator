import {
  ChangeDetectionStrategy,
  Component,
  NO_ERRORS_SCHEMA,
  inject,
} from "@angular/core";
import { BrowserGuestHostService } from "./browser-guest-host.service";

@Component({
  selector: "app-browser-guest-host",
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Electron registers this non-hyphenated tag outside Angular. Scope the schema to this host.
  schemas: [NO_ERRORS_SCHEMA],
  template: `
    <div
      class="browser-guests"
      [style.clip-path]="host.composition.sceneClip()"
    >
      @for (entry of host.entries(); track entry.key) {
        <webview
          #guest
          partition="persist:arm-nator-browser"
          [attr.src]="'about:blank#arm-nator-' + entry.mode"
          [attr.aria-label]="
            entry.mode === 'youtube' ? 'YouTube page' : 'Browser page'
          "
          [style.left.px]="entry.surface?.bounds?.x ?? 0"
          [style.top.px]="entry.surface?.bounds?.y ?? 0"
          [style.width]="
            entry.surface?.isFullscreen
              ? '100vw'
              : (entry.surface?.bounds?.width ?? 1) + 'px'
          "
          [style.height]="
            entry.surface?.isFullscreen
              ? '100vh'
              : (entry.surface?.bounds?.height ?? 1) + 'px'
          "
          [style.visibility]="entry.surface?.visible ? 'visible' : 'hidden'"
          [style.z-index]="entry.surface?.displayMode === 'mini' ? 1 : 0"
          (dom-ready)="ready(entry.key, guest)"
        ></webview>
      }
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 100;
      pointer-events: none;
    }
    .browser-guests {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    webview {
      position: absolute;
      display: flex;
      pointer-events: auto;
      border: 0;
    }
  `,
})
export class BrowserGuestHostComponent {
  readonly host = inject(BrowserGuestHostService);
  ready(key: number, element: HTMLElement): void {
    try {
      void this.host.attached(
        key,
        (
          element as HTMLElement & { getWebContentsId(): number }
        ).getWebContentsId(),
      );
    } catch {
      /* The bounded attach deadline reports a destroyed or failed guest. */
    }
  }
}
