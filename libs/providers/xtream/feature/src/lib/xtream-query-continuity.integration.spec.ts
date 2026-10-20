import { Injector, signal } from '@angular/core';
import { XtreamStore } from '@arm-nator/providers/xtream/data-access';
import { XtreamCatalogFacadeService } from './xtream-catalog-facade.service';
import { TmdbEnrichmentService } from '@arm-nator/services';

it('unchanged catalogue query does not repeat enrichment or reset restored pagination', async () => {
    const query = signal(''), page = signal(0);
    let lookups = 0;
    const store = {
        categorySearchTerm: query, selectedContentType: signal('vod'), currentPlaylist: signal({ id: 'source' }),
        setCategorySearchTerm: (value: string) => { query.set(value); page.set(0); },
        setPersonSearchTitleKeys: () => page.set(0),
    };
    const injector = Injector.create({ providers: [
        XtreamCatalogFacadeService, { provide: XtreamStore, useValue: store },
        { provide: TmdbEnrichmentService, useValue: { isEnabled: () => true, searchPersonDetails: async () => { lookups++; return null; } } },
    ] });
    try {
        const facade = injector.get(XtreamCatalogFacadeService);
        facade.setSearchQuery('Matrix');
        await Promise.resolve();
        page.set(2);
        facade.setSearchQuery('Matrix');
        expect(page()).toBe(2);
        expect(lookups).toBe(1);
        facade.setSearchQuery('Drama');
        expect(lookups).toBe(2);
    } finally { injector.destroy(); }
});
