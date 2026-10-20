import { Injectable, computed, effect, signal } from "@angular/core";
import type { EmbeddedMpvBounds } from "@arm-nator/shared/interfaces";
import { nativeSceneClip, type NativeApertureRadius } from "./native-presentation-state";
export interface NativeAperture {
  sessionId: string;
  bounds: EmbeddedMpvBounds;
  radius: NativeApertureRadius;
}
@Injectable({ providedIn: "root" })
export class NativeCompositionService {
  readonly enabled =
    typeof window !== "undefined" &&
    window.electron?.nativePlayerCompositionEnabled === true;
  private owner: string | null = null;
  private readonly current = signal<NativeAperture | null>(null);
  readonly aperture = this.current.asReadonly();
  readonly sceneClip = computed(() => {
    const a = this.aperture();
    return this.enabled && a
      ? nativeSceneClip(
          a.bounds,
          window.innerWidth,
          window.innerHeight,
          a.radius,
        )
      : "none";
  });
  constructor() {
    effect(() => {
      document.body.classList.toggle(
        "native-composition-active",
        this.enabled && this.aperture() !== null,
      );
    });
  }
  beginSession(sessionId: string): void {
    this.owner = sessionId;
    this.current.set(null);
    document.body.classList.remove("native-composition-active");
  }
  updateAperture(value: NativeAperture): void {
    if (value.sessionId !== this.owner) return;
    if (
      nativeSceneClip(
        value.bounds,
        window.innerWidth,
        window.innerHeight,
        value.radius,
      ) === "none"
    ) {
      this.hideAperture(value.sessionId);
      return;
    }
    this.current.set(value);
  }
  hideAperture(sessionId: string): void {
    if (sessionId !== this.owner) return;
    this.current.set(null);
    document.body.classList.remove("native-composition-active");
  }
  clearAperture(sessionId: string): void {
    if (sessionId !== this.owner) return;
    this.hideAperture(sessionId);
    this.owner = null;
  }
}
