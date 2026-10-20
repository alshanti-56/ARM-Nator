import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { CategoryVisibilityDialogComponent } from './category-visibility-dialog.component';

describe('Category visibility draft and saving', () => {
    function setup(save = jest.fn().mockResolvedValue(undefined)) {
        const close = jest.fn();
        const ref = { close, disableClose: false };
        const categories = [{ id: '01', name: 'Movies', hidden: false }, { id: '1', name: 'Series', hidden: true }];
        TestBed.configureTestingModule({ providers: [
            { provide: MAT_DIALOG_DATA, useValue: { categories, save } },
            { provide: MatDialogRef, useValue: ref },
            { provide: TranslateService, useValue: { instant: () => 'Save failed' } },
        ] });
        const component = TestBed.runInInjectionContext(() => new CategoryVisibilityDialogComponent());
        return { component, save, ref, categories };
    }
    it('cancel discards the draft without persisting or mutating source data', () => {
        const { component, save, ref, categories } = setup();
        component.deselectAll();
        component.cancel();
        expect(save).not.toHaveBeenCalled();
        expect(ref.close).toHaveBeenCalledWith(false);
        expect(categories[0].hidden).toBe(false);
    });
    it('failed persistence retains the draft and permits retry', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const save = jest.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce(undefined);
        const { component, ref } = setup(save);
        component.deselectAll();
        await component.save();
        expect(ref.close).not.toHaveBeenCalled();
        expect(component.saveError()).toBe('Save failed');
        expect(component.isSaving()).toBe(false);
        expect(ref.disableClose).toBe(false);
        await component.save();
        expect(save).toHaveBeenLastCalledWith(['01', '1']);
        expect(ref.close).toHaveBeenCalledWith(true);
        jest.restoreAllMocks();
    });
    it('prevents duplicate saves and changes while the write is pending', async () => {
        let finish!: () => void;
        const save = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
        const { component, ref } = setup(save);
        const pending = component.save();
        expect(ref.disableClose).toBe(true);
        component.selectAll();
        component.cancel();
        await component.save();
        expect(save).toHaveBeenCalledTimes(1);
        expect(component.selectedCount()).toBe(1);
        expect(ref.close).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(ref.close).toHaveBeenCalledWith(true);
    });
});
