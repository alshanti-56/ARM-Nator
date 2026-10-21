import {SourcePlaybackProbeHostComponent} from '@arm-nator/player/ui';
import { Component, HostListener, inject, viewChild, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Location } from '@angular/common';
import { historyShortcutDirection, isTypingInInput } from '@arm-nator/providers/shared/util';
import { ExternalPlaybackDockComponent } from '@arm-nator/ui/components';
import { NativeCompositionService, WorkspacePlayerHostComponent } from '@arm-nator/player/ui';
import { WorkspaceShellContextSidebarComponent } from './components/workspace-shell-context-sidebar/workspace-shell-context-sidebar.component';
import { WorkspaceShellHeaderComponent } from './components/workspace-shell-header/workspace-shell-header.component';
import { WorkspaceShellImportOverlayComponent } from './components/workspace-shell-import-overlay/workspace-shell-import-overlay.component';
import { WorkspaceShellRailComponent } from './components/workspace-shell-rail/workspace-shell-rail.component';
import { WorkspaceShellFacade } from './services/workspace-shell.facade';
import { WorkspaceShellXtreamImportService } from './services/workspace-shell-xtream-import.service';
import { WorkspaceShellCommandPaletteService } from './services/workspace-shell-command-palette.service';
import { WorkspaceShellHeaderService } from './services/workspace-shell-header.service';
import { WorkspaceShellRouteStateService } from './services/workspace-shell-route-state.service';
import { WorkspaceShellSearchSyncService } from './services/workspace-shell-search-sync.service';
import { WorkspaceShellSearchService } from './services/workspace-shell-search.service';
import { WorkspaceKeyboardShortcutsService } from '../workspace-keyboard-shortcuts/workspace-keyboard-shortcuts.service';
import { WorkspaceKeyboardNavigationService } from '../workspace-keyboard-navigation/workspace-keyboard-navigation.service';

@Component({
    selector: 'app-workspace-shell',
    imports: [
        ExternalPlaybackDockComponent,
        SourcePlaybackProbeHostComponent,
        WorkspacePlayerHostComponent,
        RouterOutlet,
        WorkspaceShellContextSidebarComponent,
        WorkspaceShellHeaderComponent,
        WorkspaceShellImportOverlayComponent,
        WorkspaceShellRailComponent,
    ],
    templateUrl: './workspace-shell.component.html',
    styleUrl: './workspace-shell.component.scss',
    changeDetection: ChangeDetectionStrategy.Eager,
    providers: [
        WorkspaceShellFacade,
        WorkspaceShellRouteStateService,
        WorkspaceShellSearchSyncService,
        WorkspaceShellSearchService,
        WorkspaceShellHeaderService,
        WorkspaceShellXtreamImportService,
        WorkspaceShellCommandPaletteService,
        WorkspaceKeyboardShortcutsService,
        WorkspaceKeyboardNavigationService,
    ],
})
export class WorkspaceShellComponent {
    readonly nativeComposition = inject(NativeCompositionService);
    private readonly location = inject(Location);
    readonly facade = inject(WorkspaceShellFacade);
    readonly keyboardShortcuts = inject(WorkspaceKeyboardShortcutsService);
    private readonly keyboardNavigation = inject(
        WorkspaceKeyboardNavigationService
    );
    private readonly header = viewChild<WorkspaceShellHeaderShortcutTarget>(
        'workspaceHeader'
    );

    @HostListener('document:keydown', ['$event'])
    onDocumentKeydown(event: KeyboardEvent): void {
        const historyDirection = historyShortcutDirection(event);
        if (historyDirection) {
            event.preventDefault();
            if (historyDirection === 'back') this.location.back();
            else this.location.forward();
            return;
        }
        if (
            event.defaultPrevented ||
            !this.facade.isElectron ||
            !isFindShortcut(event)
        ) {
            return;
        }

        const header = this.header();
        const target = event.target;
        if (isTypingInInput(event) && !header?.containsSearchInput(target)) {
            return;
        }

        event.preventDefault();
        this.facade.openGlobalSearch(this.facade.searchQuery());
        setTimeout(() => header?.focusSearchInput({ select: true }));
    }
}

function isFindShortcut(event: KeyboardEvent): boolean {
    return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f';
}

interface WorkspaceShellHeaderShortcutTarget {
    containsSearchInput(target: EventTarget | null): boolean;
    focusSearchInput(options?: { select?: boolean }): void;
}
