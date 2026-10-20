import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

export interface CategoryVisibilityDialogData {
    categories: { id: string; name: string; count?: number; countIsPartial?: boolean; hidden: boolean }[];
    save: (hiddenIds: string[]) => Promise<void>;
}

@Component({
    selector: 'app-category-visibility-dialog',
    imports: [MatDialogModule, MatButtonModule, MatCheckboxModule, MatIconModule, MatProgressSpinnerModule, TranslatePipe],
    templateUrl: './category-visibility-dialog.component.html',
    styleUrl: './category-visibility-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryVisibilityDialogComponent {
    private readonly data = inject<CategoryVisibilityDialogData>(MAT_DIALOG_DATA);
    private readonly ref = inject(MatDialogRef<CategoryVisibilityDialogComponent>);
    private readonly translate = inject(TranslateService);
    readonly isLoading = signal(false);
    readonly isSaving = signal(false);
    readonly saveError = signal('');
    readonly searchTerm = signal('');
    readonly categories = signal(this.data.categories.map((c) => ({ ...c, selected: !c.hidden })));
    readonly filteredCategories = computed(() => this.categories().filter((c) => c.name.toLocaleLowerCase().includes(this.searchTerm().toLocaleLowerCase())));
    readonly selectedCount = computed(() => this.categories().filter((c) => c.selected).length);
    readonly totalCount = computed(() => this.categories().length);
    readonly allSelected = computed(() => this.totalCount() > 0 && this.selectedCount() === this.totalCount());

    clearSearch(): void { this.searchTerm.set(''); }
    getItemCount(category: { count?: number; countIsPartial?: boolean }): number | string {
        return category.count == null ? '—' : category.countIsPartial ? `${category.count}+` : category.count;
    }
    toggleCategory(category: { id: string }): void {
        if (this.isSaving()) return;
        this.categories.update((rows) => rows.map((c) => c.id === category.id ? { ...c, selected: !c.selected } : c));
    }
    selectAll(): void { this.select(true); }
    deselectAll(): void { this.select(false); }
    private select(selected: boolean): void {
        if (!this.isSaving()) this.categories.update((rows) => rows.map((c) => ({ ...c, selected })));
    }
    async save(): Promise<void> {
        if (this.isSaving()) return;
        this.isSaving.set(true);
        this.saveError.set('');
        this.ref.disableClose = true;
        try {
            await this.data.save(this.categories().filter((c) => !c.selected).map((c) => c.id));
            this.ref.close(true);
        } catch (error) {
            console.error('Failed to save portal category visibility', error);
            this.saveError.set(this.translate.instant('STALKER.CATEGORY_SAVE_FAILED'));
        } finally {
            this.isSaving.set(false);
            this.ref.disableClose = false;
        }
    }
    cancel(): void { if (!this.isSaving()) this.ref.close(false); }
}
