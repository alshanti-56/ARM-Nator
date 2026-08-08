import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    input,
    output,
    signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type {
    OpenSubtitlesSearchResult,
    OpenSubtitlesDownloadedSubtitle,
    PlayerSubtitleSettings,
} from '@arm-nator/shared/interfaces';
import type { PlayerMediaTitle } from './player-controls.model';
import type {
    PlayerController,
    PlayerControlsCapabilities,
    PlayerPictureSettings,
} from './player-controls.model';

type PlayerSettingsTab =
    | 'picture'
    | 'subtitles'
    | 'audio'
    | 'playback'
    | 'screen';

@Component({
    selector: 'app-player-settings-panel',
    templateUrl: './player-settings-panel.component.html',
    styleUrl: './player-settings-panel.component.scss',
    imports: [MatIconModule, TranslatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlayerSettingsPanelComponent {
    readonly controller = input.required<PlayerController>();
    readonly mediaTitle = input<PlayerMediaTitle | null>(null);
    readonly closed = output<void>();

    readonly activeTab = signal<PlayerSettingsTab>('screen');
    readonly state = computed(() => this.controller().state());
    readonly capabilities = computed(() => this.controller().capabilities());
    readonly subtitleSearchQuery = signal('');
    readonly subtitleSearchLanguages = signal('ar');
    readonly subtitleSearchResults = signal<OpenSubtitlesSearchResult[]>([]);
    readonly subtitleSearchState = signal<'idle' | 'loading' | 'success' | 'error'>('idle');
    readonly subtitleSearchError = signal('');
    readonly subtitleDownloadId = signal<string | null>(null);
    readonly cacheState = signal<'idle' | 'clearing' | 'cleared' | 'error'>('idle');

    constructor() {
        effect(() => {
            const title = this.mediaTitle()?.primary?.trim();
            if (title && !this.subtitleSearchQuery()) {
                this.subtitleSearchQuery.set(title);
            }
        });
        effect(() => {
            const activeTab = this.activeTab();
            const activeTabConfig = this.tabs.find(
                (tab) => tab.id === activeTab
            );
            const firstAvailableTab = this.tabs.find((tab) =>
                this.isTabAvailable(tab)
            );
            if (
                firstAvailableTab &&
                activeTabConfig &&
                !this.isTabAvailable(activeTabConfig)
            ) {
                this.activeTab.set(firstAvailableTab.id);
            }
        });
    }

    readonly tabs: ReadonlyArray<{
        id: PlayerSettingsTab;
        label: string;
        icon: string;
        capability: keyof Pick<
            PlayerControlsCapabilities,
            | 'pictureAdjustments'
            | 'subtitles'
            | 'audioTracks'
            | 'playbackSpeed'
            | 'aspectRatio'
        >;
    }> = [
        {
            id: 'picture',
            label: 'PICTURE',
            icon: 'brightness_6',
            capability: 'pictureAdjustments',
        },
        {
            id: 'subtitles',
            label: 'SUBTITLES',
            icon: 'closed_caption',
            capability: 'subtitles',
        },
        {
            id: 'audio',
            label: 'AUDIO',
            icon: 'graphic_eq',
            capability: 'audioTracks',
        },
        {
            id: 'playback',
            label: 'PLAYBACK',
            icon: 'play_arrow',
            capability: 'playbackSpeed',
        },
        {
            id: 'screen',
            label: 'SCREEN',
            icon: 'crop_free',
            capability: 'aspectRatio',
        },
    ];

    readonly pictureSettings = [
        { key: 'brightness', label: 'BRIGHTNESS', min: -100, max: 100 },
        { key: 'contrast', label: 'CONTRAST', min: -100, max: 100 },
        { key: 'blackLevel', label: 'BLACK_LEVEL', min: -100, max: 100 },
        { key: 'saturation', label: 'SATURATION', min: -100, max: 100 },
        { key: 'gamma', label: 'GAMMA', min: -100, max: 100 },
    ] as const;

    selectTab(tab: PlayerSettingsTab): void {
        this.activeTab.set(tab);
    }

    updateSubtitleSearchQuery(event: Event): void {
        this.subtitleSearchQuery.set(
            (event.target as HTMLInputElement).value
        );
    }

    updateSubtitleSearchLanguages(event: Event): void {
        this.subtitleSearchLanguages.set(
            (event.target as HTMLSelectElement).value
        );
    }

    async searchSubtitles(): Promise<void> {
        const query = this.subtitleSearchQuery().trim();
        if (
            !query ||
            this.state().isLive ||
            this.subtitleSearchState() === 'loading'
        ) {
            return;
        }

        const search = window.electron?.searchOpenSubtitles;
        if (typeof search !== 'function') {
            this.subtitleSearchState.set('error');
            this.subtitleSearchError.set(
                'OpenSubtitles search is unavailable in this build.'
            );
            return;
        }

        this.subtitleSearchState.set('loading');
        this.subtitleSearchError.set('');
        try {
            const results = await search({
                query,
                languages: this.subtitleSearchLanguages(),
            });
            this.subtitleSearchResults.set(results);
            this.subtitleSearchState.set('success');
        } catch (error) {
            this.subtitleSearchResults.set([]);
            this.subtitleSearchState.set('error');
            this.subtitleSearchError.set(
                error instanceof Error
                    ? error.message
                    : 'OpenSubtitles search failed.'
            );
        }
    }

    async downloadAndApplySubtitle(
        result: OpenSubtitlesSearchResult
    ): Promise<void> {
        const download = window.electron?.downloadOpenSubtitle;
        if (typeof download !== 'function' || this.subtitleDownloadId()) {
            return;
        }

        this.subtitleDownloadId.set(result.id);
        this.subtitleSearchState.set('loading');
        this.subtitleSearchError.set('');
        try {
            const subtitle: OpenSubtitlesDownloadedSubtitle = await download({
                result,
            });
            this.controller().commands.setOnlineSubtitle(subtitle);
            this.subtitleSearchState.set('success');
        } catch (error) {
            this.subtitleSearchState.set('error');
            this.subtitleSearchError.set(
                error instanceof Error
                    ? error.message
                    : 'Subtitle download failed.'
            );
        } finally {
            this.subtitleDownloadId.set(null);
        }
    }

    isTabAvailable(tab: (typeof this.tabs)[number]): boolean {
        return this.capabilities()[tab.capability];
    }

    setPictureSetting(
        key: keyof PlayerPictureSettings,
        event: Event
    ): void {
        const value = Number((event.target as HTMLInputElement).value);
        this.controller().commands.setPictureSettings({
            ...this.state().picture,
            [key]: value,
        });
    }

    resetPictureSettings(): void {
        this.controller().commands.setPictureSettings({
            brightness: 0,
            contrast: 0,
            blackLevel: 0,
            saturation: 0,
            gamma: 0,
        });
    }

    setSubtitleNumber(
        key: Exclude<keyof PlayerSubtitleSettings, 'textColor' | 'backgroundColor'>,
        event: Event
    ): void {
        const value = Number((event.target as HTMLInputElement).value);
        this.controller().commands.setSubtitleSettings({
            ...this.state().subtitle,
            [key]: value,
        });
    }

    setSubtitleColor(
        key: 'textColor' | 'backgroundColor',
        event: Event
    ): void {
        this.controller().commands.setSubtitleSettings({
            ...this.state().subtitle,
            [key]: (event.target as HTMLInputElement).value,
        });
    }

    adjustSubtitleDelay(delta: number): void {
        const current = this.state().subtitle.delaySeconds;
        this.controller().commands.setSubtitleSettings({
            ...this.state().subtitle,
            delaySeconds: Math.max(-30, Math.min(30, current + delta)),
        });
    }

    resetSubtitleSettings(): void {
        this.controller().commands.setSubtitleSettings({
            fontSize: 100,
            textColor: '#FFFFFF',
            backgroundColor: '#000000',
            backgroundOpacity: 72,
            outlineSize: 2,
            position: 92,
            delaySeconds: 0,
        });
    }

    async clearSubtitleCache(): Promise<void> {
        const clear = window.electron?.clearOpenSubtitlesCache;
        if (typeof clear !== 'function' || this.cacheState() === 'clearing') {
            return;
        }
        this.cacheState.set('clearing');
        try {
            await clear();
            this.cacheState.set('cleared');
        } catch {
            this.cacheState.set('error');
        }
    }

    selectAudioTrack(id: number): void {
        this.controller().commands.setAudioTrack(id);
    }

    selectSubtitleTrack(id: number): void {
        this.controller().commands.setSubtitleTrack(id);
    }

    selectSpeed(speed: number): void {
        this.controller().commands.setPlaybackSpeed(speed);
    }

    selectAspect(value: string): void {
        this.controller().commands.setAspectRatio(value);
    }
}
