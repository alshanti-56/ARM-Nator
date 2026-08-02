import { inject, Provider } from '@angular/core';
import { PLAYLIST_DELETE_CLEANUP } from '@arm-nator/services';
import { ElectronXtreamDataSource } from './electron-xtream-data-source';
import {
    IXtreamDataSource,
    XTREAM_DATA_SOURCE,
} from './xtream-data-source.interface';

// Re-export all types and interfaces
export * from './xtream-data-source.interface';
export { ElectronXtreamDataSource } from './electron-xtream-data-source';

export function xtreamDataSourceFactory(): IXtreamDataSource {
    return inject(ElectronXtreamDataSource);
}

/**
 * Provider for the Xtream data source.
 * Add this to your app providers to enable the data source abstraction.
 */
export function provideXtreamDataSource(): Provider[] {
    return [
        ElectronXtreamDataSource,
        {
            provide: XTREAM_DATA_SOURCE,
            useFactory: xtreamDataSourceFactory,
        },
        {
            provide: PLAYLIST_DELETE_CLEANUP,
            multi: true,
            useFactory: () => () => Promise.resolve(),
        },
    ];
}
