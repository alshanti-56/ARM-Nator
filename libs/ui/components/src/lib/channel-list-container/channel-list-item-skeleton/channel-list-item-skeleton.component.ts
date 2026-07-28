import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
    selector: 'app-channel-list-item-skeleton',
    templateUrl: './channel-list-item-skeleton.component.html',
    styleUrl: './channel-list-item-skeleton.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelListItemSkeletonComponent {
    readonly showEpg = input(true);
    readonly actionCount = input<0 | 1 | 2 | 3>(1);
    readonly titleWidth = input(70);
    readonly metaWidth = input(40);

    readonly actionSlots = Array.from({ length: 3 }, (_, i) => i);
}
