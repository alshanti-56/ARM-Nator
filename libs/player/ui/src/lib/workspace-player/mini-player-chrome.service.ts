import { Injectable, signal } from '@angular/core';

/** Scoped to one workspace player so its header follows that player's controls. */
@Injectable()
export class MiniPlayerChromeService {
  readonly controlsVisible = signal(false);
}
