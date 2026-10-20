import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from "@angular/core";
import {
  parseSeekPreviewVtt,
  previewResourceUrl,
  seekPreviewAt,
  type SeekPreviewSource,
  type SeekPreviewCue,
} from "@arm-nator/shared/interfaces";
import { formatTime } from "./controls-format.utils";
import { cachedSeekFrame, rememberSeekFrame } from "./seek-frame-cache";
const vttCache = new Map<string, SeekPreviewCue[]>();

@Component({
  selector: "app-seek-preview",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content />
    @if (seconds(); as time) {
      <div
        class="seek-preview"
        [class.seek-preview--dock]="dock()"
        [style.left]="anchor()"
        [style.top]="dock() ? dockTop() + 'px' : null"
        aria-hidden="true"
      >
        @if (frame(); as frame) {
          <div
            class="seek-preview__image"
            [class.seek-preview__image--sprite]="!!frame.crop"
          >
            <img
              [src]="frame.url"
              alt=""
              referrerpolicy="no-referrer"
              (error)="imageFailed.set(frame.url)"
              (load)="imageLoaded($event)"
              [style.width]="spriteWidth()"
              [style.height]="spriteHeight()"
              [style.transform]="spritePosition()"
            />
          </div>
        }
        <span>{{ formatTime(time.value) }}</span>
      </div>
    }`,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        min-width: 0;
      }
      :host > input {
        width: 100%;
      }
      .seek-preview {
        position: absolute;
        bottom: calc(100% + 8px);
        width: 160px;
        transform: translateX(-50%);
        z-index: 30;
        padding: 3px;
        border-radius: 6px;
        background: #10141def;
        box-shadow: 0 3px 14px #0008;
        color: white;
        pointer-events: none;
        text-align: center;
        font: 600 12px/18px sans-serif;
        font-variant-numeric: tabular-nums;
      }
      .seek-preview__image {
        width: 160px;
        height: 90px;
        overflow: hidden;
        background: #000;
        border-radius: 3px;
        position: relative;
      }
      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .seek-preview__image--sprite img {
        position: absolute;
        left: 0;
        top: 0;
        max-width: none;
        object-fit: fill;
      }
      .seek-preview--dock {
        bottom: auto;
        top: 2px;
        width: 104px;
        padding: 2px;
        font-size: 11px;
        line-height: 16px;
      }
      .seek-preview--dock .seek-preview__image {
        width: 104px;
        height: 36px;
      }
    `,
  ],
  host: {
    "[attr.data-frame-cache-status]": "frameCacheStatus()",
    "(pointermove)": "previewPointer($event)",
    "(pointerdown)": "dragging.set(true)",
    "(pointerup)": "dragging.set(false)",
    "(pointercancel)": "hide()",
    "(pointerleave)": "leave()",
    "(input)": "previewInput($event)",
    "(focusout)": "hide()",
  },
})
export class SeekPreviewComponent {
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement;
  readonly duration = input(0);
  readonly enabled = input(true);
  readonly dock = input(false);
  readonly dockSurface = input<HTMLElement | null>(null);
  readonly dockTop = signal(2);
  readonly source = input<SeekPreviewSource | undefined>();
  readonly cacheKey = input("");
  readonly videoSurface = input<HTMLElement | null>(null);
  readonly seconds = signal<{ value: number; percent: number } | null>(null);
  readonly dragging = signal(false);
  private readonly imageSize = signal({ url: "", width: 0, height: 0 });
  readonly imageFailed = signal("");
  readonly frameCacheStatus = signal('waiting');
  private readonly cues = signal<SeekPreviewCue[]>([]);
  private readonly cacheRevision = signal(0);
  private sourceGeneration = 0;
  private load: AbortController | null = null;
  readonly formatTime = formatTime;
  readonly anchor = computed(() => {
    const width = this.dock() ? 54 : 84;
    return `clamp(${width}px, ${this.seconds()?.percent ?? 0}%, calc(100% - ${width}px))`;
  });
  readonly frame = computed(() => {
    this.cacheRevision();
    const time = this.seconds();
    if (!time) return null;
    const supplied =
      seekPreviewAt(this.source() ?? {}, time.value, this.duration()) ??
      seekPreviewAt(this.cues(), time.value);
    const frame = supplied ?? cachedSeekFrame(this.cacheKey(), time.value);
    return frame?.url !== this.imageFailed() ? frame : null;
  });
  private readonly scale = computed(() => {
    const crop = this.frame()?.crop;
    return crop ? (this.dock() ? 104 : 160) / crop.width : 1;
  });
  readonly spriteWidth = computed(() =>
    this.frame()?.crop ? `${this.imageSize().width * this.scale()}px` : "100%",
  );
  readonly spriteHeight = computed(() => {
    const crop = this.frame()?.crop;
    return crop
      ? `${(this.imageSize().height * (this.dock() ? 36 : 90)) / crop.height}px`
      : "100%";
  });
  readonly spritePosition = computed(() => {
    const crop = this.frame()?.crop;
    if (!crop) return "none";
    return `translate(${-crop.x * this.scale()}px, ${(-crop.y * (this.dock() ? 36 : 90)) / crop.height}px)`;
  });
  constructor() {
    effect(() => { if (!this.enabled() || this.duration() <= 0) this.hide(); });
    effect((onCleanup) => {
      this.source();
      this.cacheKey();
      ++this.sourceGeneration;
      this.load?.abort();
      this.load = null;
      this.cues.set([]);
      this.imageFailed.set("");
      this.seconds.set(null);
      this.frameCacheStatus.set('waiting');
      onCleanup(() => this.load?.abort());
    });
    effect((onCleanup) => {
      const surface = this.videoSurface(),
        key = this.cacheKey();
      if (!surface || !key || !this.enabled()) return;
      let video: HTMLVideoElement | null = null,
        canvasBlocked = false,
        pending = false,
        lastAttempt = -Infinity,
        disposed = false;
      const unobscured = () => !surface.querySelector('.player-controls__bar--visible') &&
        !document.querySelector('.cdk-overlay-pane');
      const captureDisplayed = () => {
        const captureFrame = window.electron?.captureWebVideoFrame;
        if (!captureFrame || !video || pending || !unobscured() || Date.now() - lastAttempt < 10000) return;
        const target = video, time = video.currentTime, source = video.currentSrc,
          generation = this.sourceGeneration, rect = video.getBoundingClientRect();
        if (rect.width < 32 || rect.height < 18 || rect.x < 0 || rect.y < 0) return;
        pending = true; lastAttempt = Date.now();
        void captureFrame({x:rect.x,y:rect.y,width:rect.width,height:rect.height})
          .then(image => {
            const bounds = target.getBoundingClientRect();
            if (disposed || generation !== this.sourceGeneration || video !== target ||
                target.currentSrc !== source || target.seeking || document.hidden || !unobscured() ||
                Math.floor(target.currentTime / 30) !== Math.floor(time / 30) ||
                ['x','y','width','height'].some(k => Math.abs(bounds[k as keyof DOMRect] as number - (rect[k as keyof DOMRect] as number)) > 1)) return;
            if (image) {
              rememberSeekFrame(key,time,image);
              this.frameCacheStatus.set('renderer');
              this.cacheRevision.update(n => n + 1);
            } else this.frameCacheStatus.set('unavailable');
          })
          .catch(() => { if (!disposed) this.frameCacheStatus.set('unavailable'); })
          .finally(() => { pending = false; });
      };
      const capture = () => {
        if (
          !video ||
          video.seeking ||
          video.readyState < 2 ||
          video.videoWidth <= 0 ||
          document.hidden ||
          cachedSeekFrame(key, video.currentTime)
        )
          return;
        if (canvasBlocked) { captureDisplayed(); return; }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 160;
          canvas.height = 90;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, 160, 90);
          rememberSeekFrame(
            key,
            video.currentTime,
            canvas.toDataURL("image/jpeg", 0.55),
          );
          this.cacheRevision.update((n) => n + 1);
          this.frameCacheStatus.set('canvas');
        } catch (error) {
          this.frameCacheStatus.set('unavailable');
          if (error instanceof DOMException && error.name === 'SecurityError') {
            canvasBlocked = true;
            captureDisplayed();
          }
        }
      };
      const attach = () => {
        const candidate = surface.querySelector("video");
        if (candidate === video) return;
        video?.removeEventListener("timeupdate", capture);
        video = candidate;
        canvasBlocked = false;
        video?.addEventListener("timeupdate", capture);
      };
      attach();
      const observer = new MutationObserver(attach);
      observer.observe(surface, { childList: true, subtree: true });
      onCleanup(() => {
        disposed = true;
        observer.disconnect();
        video?.removeEventListener("timeupdate", capture);
      });
    });
  }
  imageLoaded(event: Event): void {
    const image = event.target as HTMLImageElement;
    this.imageSize.set({
      url: image.src,
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }
  previewPointer(event: PointerEvent): void {
    if (
      !this.enabled() ||
      !Number.isFinite(this.duration()) ||
      this.duration() <= 0
    )
      return;
    const input = this.host.querySelector("input");
    if (!input || input.disabled) return;
    const rect = input.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    this.positionInDock();
    this.seconds.set({
      value: fraction * this.duration(),
      percent: fraction * 100,
    });
    this.loadCues();
  }
  previewInput(event: Event): void {
    const input = event.target as HTMLInputElement,
      value = Number(input.value);
    if (!this.enabled() || this.duration() <= 0 || !Number.isFinite(value))
      return;
    this.positionInDock();
    this.seconds.set({
      value: Math.max(0, Math.min(this.duration(), value)),
      percent: Math.max(0, Math.min(100, (value / this.duration()) * 100)),
    });
    this.loadCues();
  }
  private positionInDock(): void {
    const dock = this.dockSurface();
    if (this.dock() && dock) {
      // Native video sits above Chromium; keep the entire card in the dock.
      this.dockTop.set(dock.getBoundingClientRect().top - this.host.getBoundingClientRect().top + 2);
    }
  }
  leave(): void {
    if (!this.dragging()) this.hide();
  }
  hide(): void {
    this.dragging.set(false);
    this.seconds.set(null);
  }
  private loadCues(): void {
    const url = previewResourceUrl(this.source()?.vttUrl, "vtt");
    if (!url || this.load) return;
    const cached = vttCache.get(url);
    if (cached) {
      this.cues.set(cached);
      return;
    }
    const controller = new AbortController(),
      generation = this.sourceGeneration;
    this.load = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    void (async () => {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "text/vtt" },
        credentials: "omit",
      });
      if (
        !response.ok ||
        /^(?:video|audio)\//i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        Number(response.headers.get("content-length")) > 262144
      ) {
        await response.body?.cancel();
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let text = "",
        bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 262144) {
            await reader.cancel();
            return;
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      if (controller.signal.aborted || generation !== this.sourceGeneration)
        return;
      const cues = parseSeekPreviewVtt(text, url);
      this.cues.set(cues);
      vttCache.set(url, cues);
      while (vttCache.size > 8) vttCache.delete(vttCache.keys().next().value!);
    })()
      .catch(() => undefined)
      .finally(() => clearTimeout(timeout));
  }
}
