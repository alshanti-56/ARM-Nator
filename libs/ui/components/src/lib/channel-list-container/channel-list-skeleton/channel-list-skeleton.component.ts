import {
    ChangeDetectionStrategy,
    Component,
    computed,
    input,
} from '@angular/core';
import { ChannelListItemSkeletonComponent } from '../channel-list-item-skeleton/channel-list-item-skeleton.component';

const TITLE_WIDTHS = [72, 61, 68, 54, 78, 64, 70, 57, 75, 66, 73, 59];
const META_WIDTHS = [38, 34, 42, 36, 44, 35, 40, 32, 39, 37, 43, 33];

@Component({
    selector: 'app-channel-list-skeleton',
    templateUrl: './channel-list-skeleton.component.html',
    styleUrl: './channel-list-skeleton.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [ChannelListItemSkeletonComponent],
})
export class ChannelListSkeletonComponent {
    readonly count = input(9);
    readonly showEpg = input(true);
    readonly actionCount = input<0 | 1 | 2 | 3>(1);

    readonly rows = computed(() =>
        Array.from({ length: this.count() }, (_, index) => ({
            index,
            title: TITLE_WIDTHS[index % TITLE_WIDTHS.length],
            meta: META_WIDTHS[index % META_WIDTHS.length],
        }))
    );
}
