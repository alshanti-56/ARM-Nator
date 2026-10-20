import {
    ChangeDetectionStrategy,
    Component,
    input,
    output,
} from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { TranslatePipe } from '@ngx-translate/core';
import { WorkspaceContextErrorViewComponent } from './workspace-context-error-view.component';

interface WorkspaceCategoryViewItem {
    readonly category_id?: string | number;
    readonly category_name?: string;
    readonly count?: number;
    readonly id?: string | number;
    readonly name?: string;
}

@Component({
    selector: 'app-workspace-context-category-view',
    imports: [MatListModule, TranslatePipe, WorkspaceContextErrorViewComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: './workspace-context-category-view.component.html',
    styleUrl: './workspace-context-category-view.component.scss',
})
export class WorkspaceContextCategoryViewComponent {
    readonly items = input<ReadonlyArray<WorkspaceCategoryViewItem>>([]);
    readonly selectedCategoryId = input<string | number | null | undefined>();
    readonly itemCounts = input<ReadonlyMap<string | number, number>>(new Map());
    readonly partialCountIds = input<ReadonlySet<string>>(new Set());
    readonly showCounts = input(false);
    readonly countDisplayMode = input<'loading' | 'ready'>('ready');
    /**
     * When true, items without an entry in `itemCounts` render no badge at
     * all instead of "0" — used for censored (adult) genres whose
     * real channel count is unknown to the full-list cache.
     */
    readonly omitMissingCounts = input(false);
    readonly interactionEnabled = input(true);
    readonly statusText = input('');

    readonly categoryClicked = output<WorkspaceCategoryViewItem>();

    isSelected(item: WorkspaceCategoryViewItem): boolean {
        const selectedCategory = this.selectedCategoryId();
        const itemId = item.category_id ?? item.id;
        return (
            selectedCategory != null &&
            String(selectedCategory) === String(itemId)
        );
    }

    getItemCount(item: WorkspaceCategoryViewItem): number {
        const itemId = String(item.id ?? item.category_id);
        return this.itemCounts().get(itemId) ?? this.itemCounts().get(Number(itemId)) ?? item.count ?? 0;
    }

    hasItemCount(item: WorkspaceCategoryViewItem): boolean {
        if (!this.omitMissingCounts()) {
            return true;
        }

        // NaN (from the "*" all-category id) is a valid Map key here.
        return (
            this.itemCounts().has(String(item.id ?? item.category_id)) ||
            this.itemCounts().has(Number(item.id ?? item.category_id)) ||
            item.count !== undefined
        );
    }

    isPartialCount(item: WorkspaceCategoryViewItem): boolean {
        return this.partialCountIds().has(String(item.id ?? item.category_id));
    }

    onCategoryClick(item: WorkspaceCategoryViewItem): void {
        if (!this.interactionEnabled()) {
            return;
        }

        this.categoryClicked.emit(item);
    }
}
