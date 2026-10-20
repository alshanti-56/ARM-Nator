import { Injectable } from '@angular/core';
import { CatalogueNavigationMemory, type StalkerListState } from './catalogue-navigation-state';

@Injectable({ providedIn: 'root' })
export class CatalogueNavigationStateService extends CatalogueNavigationMemory {
    readonly stalkerLists = new CatalogueNavigationMemory<StalkerListState>(16);
    constructor() { super(); }
}
