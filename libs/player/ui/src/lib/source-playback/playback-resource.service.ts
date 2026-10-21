import { Injectable, signal } from "@angular/core";
import { PlaybackResourceCoordinator } from "@arm-nator/player/core";
@Injectable({ providedIn: "root" })
export class PlaybackResourceService {
  readonly version = signal(0);
  readonly coordinator = new PlaybackResourceCoordinator();
  private readonly blockers = new Set<() => boolean>();
  registerBlocker(blocked: () => boolean): () => void {
    this.blockers.add(blocked);
    return () => this.blockers.delete(blocked);
  }
  isBlocked(): boolean {
    this.version();
    this.coordinator.setOccupied(
      [...this.blockers].some((blocked) => blocked()),
    );
    return this.coordinator.isBlocked();
  }
  tryAcquireBackground(close: () => Promise<void>) {
    this.coordinator.setOccupied(
      [...this.blockers].some((blocked) => blocked()),
    );
    const lease = this.coordinator.tryAcquireBackground(close);
    if (!lease) return null;
    this.version.update((v) => v + 1);
    return {
      signal: lease.signal,
      release: () =>
        lease.release().finally(() => this.version.update((v) => v + 1)),
    };
  }
  withForeground<T>(action: () => Promise<T>): Promise<T> {
    const reservation = this.coordinator.reserveForeground();
    this.version.update((v) => v + 1);
    const finish = () => {
      reservation.finish();
      this.version.update((v) => v + 1);
    };
    if (reservation.ready)
      return reservation.ready.then(action).finally(finish);
    try {
      return Promise.resolve(action()).finally(finish);
    } catch (error) {
      finish();
      return Promise.reject(error);
    }
  }
}
