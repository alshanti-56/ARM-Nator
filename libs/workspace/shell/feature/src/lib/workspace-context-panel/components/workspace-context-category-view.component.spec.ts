import { TestBed } from '@angular/core/testing';
import { WorkspaceContextCategoryViewComponent } from './workspace-context-category-view.component';

describe('Category count presentation', () => {
    it('preserves distinct Stalker string IDs and marks partial counts', () => {
        const fixture = TestBed.createComponent(WorkspaceContextCategoryViewComponent);
        fixture.componentRef.setInput('itemCounts', new Map([['01', 12], ['1', 4], ['shows', 8]]));
        fixture.componentRef.setInput('partialCountIds', new Set(['shows']));
        fixture.componentRef.setInput('omitMissingCounts', true);
        const view = fixture.componentInstance;
        expect(view.getItemCount({ category_id: '01' })).toBe(12);
        expect(view.getItemCount({ category_id: '1' })).toBe(4);
        expect(view.isPartialCount({ category_id: 'shows' })).toBe(true);
        expect(view.isPartialCount({ category_id: '01' })).toBe(false);
        expect(view.hasItemCount({ category_id: 'missing' })).toBe(false);
    });
    it('retains Xtream numeric maps and the synthetic All category adapter', () => {
        const fixture = TestBed.createComponent(WorkspaceContextCategoryViewComponent);
        fixture.componentRef.setInput('itemCounts', new Map([[12, 63], [Number.NaN, 500]]));
        const view = fixture.componentInstance;
        expect(view.getItemCount({ category_id: 12 })).toBe(63);
        expect(view.getItemCount({ category_id: '*' })).toBe(500);
        expect(view.isPartialCount({ category_id: 12 })).toBe(false);
    });
});
