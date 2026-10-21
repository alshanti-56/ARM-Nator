import { Injectable } from "@angular/core";
import { PlaybackResourceCoordinator } from "@arm-nator/player/core";
@Injectable({ providedIn: "root" })
export class PlaybackResourceService {
  readonly coordinator = new PlaybackResourceCoordinator();
  private readonly blockers = new Set<() => boolean>();
  registerBlocker(blocked: () => boolean): () => void {
    this.blockers.add(blocked);
    return () => this.blockers.delete(blocked);
  }
  tryAcquireBackground(close: () => Promise<void>) {
    this.coordinator.setOccupied(
      [...this.blockers].some((blocked) => blocked()),
    );
    return this.coordinator.tryAcquireBackground(close);
  }
  withForeground<T>(action: () => Promise<T>): Promise<T> {
    const reservation = this.coordinator.reserveForeground();
    if (reservation.ready)
      return reservation.ready.then(action).finally(reservation.finish);
    try {
      return Promise.resolve(action()).finally(reservation.finish);
    } catch (error) {
      reservation.finish();
      return Promise.reject(error);
    }
  }
}
