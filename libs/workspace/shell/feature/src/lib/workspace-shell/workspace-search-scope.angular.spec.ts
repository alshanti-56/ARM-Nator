import { CUSTOM_ELEMENTS_SCHEMA, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { provideTranslateService } from "@ngx-translate/core";
import { PlaylistSwitcherComponent } from "@arm-nator/providers/shared/playlist-ui";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import { RuntimeCapabilitiesService } from "@arm-nator/services";
import { WorkspaceShellHeaderComponent } from "./components/workspace-shell-header/workspace-shell-header.component";
import { WorkspaceShellSearchService } from "./services/workspace-shell-search.service";
import { WorkspaceShellRouteStateService } from "./services/workspace-shell-route-state.service";
import { WorkspaceShellSearchSyncService } from "./services/workspace-shell-search-sync.service";

describe("search scope in the workspace header", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [WorkspaceShellHeaderComponent],
      providers: [provideRouter([]), provideTranslateService()],
    }).overrideComponent(WorkspaceShellHeaderComponent, {
      remove: { imports: [PlaylistSwitcherComponent] },
      add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
  });

  it("global search has one editable query without controls implying a selected-source scope", async () => {
    const fixture = TestBed.createComponent(WorkspaceShellHeaderComponent);
    fixture.componentRef.setInput("canUseSearch", true);
    fixture.componentRef.setInput("playlistTitle", "Selected provider");
    fixture.componentRef.setInput("searchQuery", "Dune");
    fixture.componentRef.setInput("searchScopeLabel", "Global search");
    fixture.componentRef.setInput("isGlobalSearchRoute", true);
    const changed = jest.fn(),
      submitted = jest.fn();
    fixture.componentInstance.searchChanged.subscribe(changed);
    fixture.componentInstance.searchSubmitted.subscribe(submitted);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector("app-playlist-switcher"),
    ).toBeNull();
    const inputs = fixture.nativeElement.querySelectorAll("input");
    expect(inputs).toHaveLength(1);
    const query = inputs[0] as HTMLInputElement;
    expect(query.value).toBe("Dune");
    expect(fixture.nativeElement.textContent).toContain("Global search");
    query.value = "Alien";
    query.dispatchEvent(new Event("input"));
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(changed).toHaveBeenCalledWith("Alien");
    expect(submitted).toHaveBeenCalledWith("Alien");
    // Cmd/Ctrl+F delegates to this method, so the remaining input must stay focusable.
    document.body.appendChild(fixture.nativeElement);
    fixture.componentInstance.focusSearchInput({ select: true });
    expect(document.activeElement).toBe(query);
    expect(query.selectionStart).toBe(0);
    expect(query.selectionEnd).toBe(query.value.length);
    fixture.destroy();
  });

  it("source browsing keeps its playlist switcher and local scope", () => {
    const fixture = TestBed.createComponent(WorkspaceShellHeaderComponent);
    fixture.componentRef.setInput("canUseSearch", true);
    fixture.componentRef.setInput("searchScopeLabel", "Movies / Action");
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector("app-playlist-switcher"),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain("Movies / Action");
    fixture.destroy();
  });

  it("global search keeps its query available before the first source is added", () => {
    const fixture = TestBed.createComponent(WorkspaceShellHeaderComponent);
    fixture.componentRef.setInput("canUseSearch", true);
    fixture.componentRef.setInput("isGlobalSearchRoute", true);
    fixture.componentRef.setInput("hasNoPlaylists", true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll("input")).toHaveLength(1);
    fixture.destroy();
  });
});

it("the global query remains available when the library only contains connected portals", () => {
  const sync = {
    searchQuery: signal(""),
    appliedSearchQuery: signal(""),
    onSearchInput: jest.fn(),
  };
  const playlists = signal([
    { _id: "portal-only", macAddress: "00:00:00:00:00:01" },
  ]);
  TestBed.configureTestingModule({
    providers: [
      WorkspaceShellSearchService,
      provideTranslateService(),
      { provide: Router, useValue: {} },
      { provide: XtreamStore, useValue: {} },
      {
        provide: RuntimeCapabilitiesService,
        useValue: { supportsGlobalSearch: true },
      },
      { provide: WorkspaceShellSearchSyncService, useValue: sync },
      {
        provide: WorkspaceShellRouteStateService,
        useValue: {
          currentRoute: signal({
            kind: "global-search",
            context: null,
            section: null,
          }),
          playlists,
        },
      },
    ],
  });
  const search = TestBed.inject(WorkspaceShellSearchService);
  expect(search.canUseSearch()).toBe(true);
  search.onSearchInput("Dune");
  expect(sync.onSearchInput).toHaveBeenCalledWith("Dune");
  playlists.set([]);
  expect(search.canUseSearch()).toBe(true);
});
