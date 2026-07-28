import { Directive, inject, TemplateRef } from '@angular/core';
import {
    SeriesResumeTarget,
    UnifiedCollectionItem,
} from '@arm-nator/providers/shared/util';

export interface UnifiedCollectionDetailContext {
    $implicit: UnifiedCollectionItem;
    item: UnifiedCollectionItem;
    seriesResume: SeriesResumeTarget | null;
    close: () => void;
}

@Directive({
    selector: 'ng-template[unifiedCollectionDetail]',
})
export class UnifiedCollectionDetailDirective {
    readonly templateRef = inject(TemplateRef<UnifiedCollectionDetailContext>);
}
