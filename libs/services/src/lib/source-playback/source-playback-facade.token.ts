import { InjectionToken, type Signal } from "@angular/core";
import type {
  SourceEvidenceKey,
  SourcePlaybackReason,
} from "@arm-nator/shared/interfaces";
export interface SourcePlaybackActivity {
  state: "idle" | "queued" | "checking" | "deferred" | "teardown-pending";
  key?: SourceEvidenceKey;
  reason?: SourcePlaybackReason;
  phase?: "discovering" | "sample";
  sampleIndex?: number;
  sampleCount?: number;
  sampleTitle?: string;
}
export interface SourcePlaybackFacade {
  available: Signal<boolean>;
  activity: Signal<SourcePlaybackActivity>;
  beginSourceOperation?(sourceId: string): Promise<() => void>;
  requestCheck(key: SourceEvidenceKey): Promise<void>;
}
export const SOURCE_PLAYBACK_FACADE = new InjectionToken<SourcePlaybackFacade>(
  "Source playback checks",
);
