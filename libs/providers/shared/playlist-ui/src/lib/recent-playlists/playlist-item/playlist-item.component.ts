import {SourcePlaybackDetailsComponent} from '../source-playback-details/source-playback-details.component';
import type {SourcePlaybackCategory,SourcePlaybackSummary,SourceAccountSnapshot,SourceEvidenceKey} from '@arm-nator/shared/interfaces';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { DatePipe } from '@angular/common';
import {
  Component,
  Input,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltip } from '@angular/material/tooltip';
import { normalizeDateLocale } from '@arm-nator/pipes';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { startWith } from 'rxjs';
import {
    PortalStatus,
    PortalStatusService,
    RuntimeCapabilitiesService,
} from '@arm-nator/services';
import {
    getPlaylistSourceType,
    PlaylistMeta,
    PlaylistSourceType,
} from '@arm-nator/shared/interfaces';

@Component({
    selector: 'app-playlist-item',
    templateUrl: './playlist-item.component.html',
    styleUrls: ['./playlist-item.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [
        DatePipe,
        SourcePlaybackDetailsComponent,
        DragDropModule,
        MatButtonModule,
        MatIconButton,
        MatIcon,
        MatProgressBarModule,
        MatProgressSpinnerModule,
        MatTooltip,
        TranslatePipe,
    ],
})
export class PlaylistItemComponent implements OnInit {
    @Input() item!: PlaylistMeta;
    readonly showActions = input(true);
    readonly sourceEvidence=input<readonly SourcePlaybackSummary[]>([]);
    readonly sourceAccount=input<SourceAccountSnapshot|null>(null);
    readonly expandedCategory=signal<SourcePlaybackCategory|null>(null);
    readonly selectedEvidence=computed(()=>this.sourceEvidence().find(s=>s.key.category===this.expandedCategory())??null);
    readonly latestChecked=computed(()=>Math.max(0,...this.sourceEvidence().map(s=>s.latestAttempt?.completedAt??s.latest?.completedAt??0)));
    readonly sourceCheckRequested=output<SourceEvidenceKey>();
    toggleDetails(event:Event,category?:SourcePlaybackCategory):void{event.stopPropagation();if(this.isBusy())return;this.expandedCategory.set(category??(this.expandedCategory()?null:'live'));}
    checkedAge():string{const at=this.latestChecked();if(!at)return this.translate.instant("WORKSPACE.SOURCES.PLAYBACK.NEVER");const minutes=Math.floor(Math.max(0,Date.now()-at)/60000);return new Intl.RelativeTimeFormat(this.translate.currentLang()||"en",{numeric:"auto"}).format(minutes<60?-minutes:minutes<1440?-Math.floor(minutes/60):-Math.floor(minutes/1440),minutes<60?"minute":minutes<1440?"hour":"day");}
    resultIcon(result:string):string{return result==='verified'?'check_circle':result==='failed'?'error_outline':result==='untested'?'help_outline':'warning_amber';}

    readonly isDraggable = input(false);
    readonly isSelected = input(false);
    readonly isRefreshing = input(false);
    readonly isDeleting = input(false);
    readonly busyMessage = input('');
    readonly busyProgress = input<number | null>(null);
    readonly canCancelBusyAction = input(false);
    readonly isBusy = computed(() => this.isRefreshing() || this.isDeleting());

    get sourceType(): PlaylistSourceType {
        return getPlaylistSourceType(this.item);
    }

    readonly editPlaylistClicked = output<PlaylistMeta>();
    readonly playlistClicked = output<string>();
    readonly refreshClicked = output<PlaylistMeta>();
    readonly removeClicked = output<string>();
    readonly cancelBusyActionClicked = output<void>();

    portalStatus: PortalStatus = 'unavailable';
    private readonly portalStatusService = inject(PortalStatusService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly translate = inject(TranslateService);
    private readonly languageTick = toSignal(
        this.translate.onLangChange.pipe(startWith(null)),
        { initialValue: null }
    );

    readonly supportsXtreamSqliteDataSource =
        this.runtime.supportsXtreamSqliteDataSource;
    readonly currentLocale = computed(() => {
        this.languageTick();
        return normalizeDateLocale(
            this.translate.currentLang() || this.translate.fallbackLang()
        );
    });

    async ngOnInit() {
        await this.checkPortalStatus();
    }

    private async checkPortalStatus() {
        if (this.sourceType === 'stalker') {
            if (!this.item.portalUrl || !this.item.macAddress) {
                return;
            }
            this.portalStatus =
                await this.portalStatusService.checkStalkerPortalStatus(
                    this.item.portalUrl,
                    this.item.macAddress,
                    {
                        token: this.item.stalkerToken,
                        serialNumber: this.item.stalkerSerialNumber,
                    }
                );
            return;
        }

        if (this.item.serverUrl && this.item.username && this.item.password) {
            this.portalStatus = await this.portalStatusService.checkPortalStatus(
                this.item.serverUrl,
                this.item.username,
                this.item.password
            );
        }
    }

    getStatusClass(): string {
        return this.portalStatusService.getStatusClass(this.portalStatus);
    }

    getStatusIcon(): string {
        return this.portalStatusService.getStatusIcon(this.portalStatus);
    }

    onPlaylistClick(): void {
        if (this.isBusy()) {
            return;
        }

        this.playlistClicked.emit(this.item._id);
    }
}
