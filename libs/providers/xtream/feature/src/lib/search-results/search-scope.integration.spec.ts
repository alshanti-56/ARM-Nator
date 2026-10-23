import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Location } from "@angular/common";
import { ActivatedRoute, Router, convertToParamMap } from "@angular/router";
import { BehaviorSubject } from "rxjs";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import {
  CatalogTitleMatchService,
  DatabaseService,
  TmdbEnrichmentService,
  UiPerformanceService,
} from "@arm-nator/services";
import { SearchResultsComponent } from "./search-results.component";
import { UnifiedDiscoveryState } from "./unified-discovery-state.service";

function createSearchPage(workspace: boolean) {
  const searchTerm = signal("");
  const searchFilters = signal({ live: true, movie: true, series: true });
  const results = signal([]);
  const store = {
    searchTerm,
    searchFilters,
    searchResults: results,
    isSearching: signal(false),
    setSearchTerm: (term: string) => searchTerm.set(term),
    setSearchFilters: (filters: ReturnType<typeof searchFilters>) =>
      searchFilters.set(filters),
    setIsSearching: jest.fn(),
    setGlobalSearchResults: (value: []) => results.set(value),
    setSelectedContentType: jest.fn(),
  };
  const route = {
    snapshot: {
      data: {
        isGlobalSearch: true,
        ...(workspace ? { layout: "workspace" } : {}),
      },
      queryParamMap: convertToParamMap({}),
    },
    queryParamMap: new BehaviorSubject(convertToParamMap({})),
  };
  const state = {
    update: jest.fn(),
    groups: signal([]),
    portals: signal([]),
    snapshot: signal({ versions: [], statuses: [] }),
    searching: signal(false),
    choosing: signal(null),
    error: signal(null),
  };
  TestBed.configureTestingModule({
    imports: [SearchResultsComponent],
    providers: [
      { provide: XtreamStore, useValue: store },
      { provide: ActivatedRoute, useValue: route },
      {
        provide: Router,
        useValue: { navigate: jest.fn().mockResolvedValue(true) },
      },
      { provide: Location, useValue: {} },
      {
        provide: DatabaseService,
        useValue: { globalSearchContent: jest.fn().mockResolvedValue([]) },
      },
      { provide: TmdbEnrichmentService, useValue: {} },
      { provide: CatalogTitleMatchService, useValue: {} },
      { provide: UiPerformanceService, useValue: { painted: jest.fn() } },
    ],
  }).overrideComponent(SearchResultsComponent, {
    set: { providers: [{ provide: UnifiedDiscoveryState, useValue: state }] },
  });
  return {
    fixture: TestBed.createComponent(SearchResultsComponent),
    searchTerm,
  };
}

describe("global search page controls", () => {
  beforeEach(() => localStorage.clear());

  it("workspace search uses the header query and explains indexed versus portal scope", () => {
    const { fixture } = createSearchPage(true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('input[name="query"]'),
    ).toBeNull();
    expect(fixture.nativeElement.textContent).toContain("Search portals");
    fixture.destroy();
  });

  it("search outside the workspace retains an editable query and explicit submission", async () => {
    const { fixture, searchTerm } = createSearchPage(false);
    fixture.detectChanges();
    await fixture.whenStable();
    const query = fixture.nativeElement.querySelector(
      'input[name="query"]',
    ) as HTMLInputElement;
    expect(query).not.toBeNull();
    query.value = "Dune";
    query.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(searchTerm()).toBe("Dune");
    const execute = jest.spyOn(fixture.componentInstance, "executeSearch");
    fixture.nativeElement
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(execute).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });
});
