import { SearchResultsComponent } from "./search-results.component";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import {
  DatabaseService,
  TmdbEnrichmentService,
  CatalogTitleMatchService,
  UiPerformanceService,
} from "@arm-nator/services";
import { ActivatedRoute, Router, convertToParamMap } from "@angular/router";
import { Location } from "@angular/common";
import { BehaviorSubject } from "rxjs";
import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { InteractivityChecker } from "@angular/cdk/a11y";
import { By } from "@angular/platform-browser";
import { UnifiedDiscoveryResultsComponent } from "./unified-discovery.component";
import { UnifiedDiscoveryState } from "./unified-discovery-state.service";
import { AdvancedSearchComponent } from "./advanced-search.component";
import {
  discoveryMediaHints,
  type DiscoveryVersion,
} from "@arm-nator/shared/interfaces";

const movie = (source: string): DiscoveryVersion => ({
  identity: {
    sourceType: "xtream",
    playlistId: source,
    contentKind: "vod",
    providerItemId: "7",
  },
  providerName: source,
  categoryId: "1",
  originalTitle: "|FR| Movie (2026)",
  contentType: "movie",
  work: { kind: "movie", title: "Movie", releaseYear: 2026 },
  navigation: [source],
});

it("browsing stays simple; Sources exposes exact provider choices without starting playback", async () => {
  const a = movie("a"),
    b = { ...movie("b"), ...discoveryMediaHints("|MULTI| Movie (2026)") };
  const group = { key: "movie", versions: [a, b] };
  const state = {
    groups: signal([group]),
    choosing: signal(null),
    error: signal(null),
    rank: jest.fn().mockResolvedValue([b, a]),
    choose: jest.fn().mockResolvedValue(b),
    versionKey: (v: DiscoveryVersion) => v.identity.playlistId,
  };
  TestBed.configureTestingModule({
    imports: [UnifiedDiscoveryResultsComponent],
    providers: [{ provide: UnifiedDiscoveryState, useValue: state }],
  });
  const fixture = TestBed.createComponent(UnifiedDiscoveryResultsComponent);
  const selected = jest.fn();
  fixture.componentInstance.selected.subscribe(selected);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  fixture.debugElement.query(By.css(".poster-select")).nativeElement.click();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain("Sources (2)");
  expect(fixture.debugElement.queryAll(By.css(".version-row"))).toHaveLength(0);
  fixture.debugElement.query(By.css(".sources-toggle")).nativeElement.click();
  fixture.detectChanges();
  expect(fixture.debugElement.queryAll(By.css(".version-row"))).toHaveLength(2);
  expect(
    fixture.debugElement
      .queryAll(By.css(".version-facts"))[1]
      .nativeElement.textContent.trim(),
  ).toBe("Quality unknown · Multi");
  expect(state.choose).not.toHaveBeenCalled();
  expect(selected).not.toHaveBeenCalled();
  fixture.debugElement
    .queryAll(By.css(".version-open"))[0]
    .nativeElement.click();
  await fixture.whenStable();
  expect(state.choose).toHaveBeenCalledWith(group, a);
  expect(selected).toHaveBeenCalledWith(b);
});

it("Advanced search edits remain drafts until explicit submission and Clear does not submit", async () => {
  TestBed.configureTestingModule({
    imports: [AdvancedSearchComponent],
    providers: [
      {
        provide: InteractivityChecker,
        useValue: { isFocusable: () => true, isTabbable: () => true },
      },
    ],
  });
  const fixture = TestBed.createComponent(AdvancedSearchComponent);
  const submitted = jest.fn();
  fixture.componentInstance.submitted.subscribe(submitted);
  fixture.detectChanges();
  fixture.componentInstance.toggle();
  fixture.detectChanges();
  await fixture.whenStable();
  const title = document.querySelector<HTMLInputElement>(
    '[name="advanced-title"]',
  )!;
  title.value = "Matrix";
  title.dispatchEvent(new Event("input"));
  fixture.detectChanges();
  expect(submitted).not.toHaveBeenCalled();
  const form = document.querySelector<HTMLFormElement>(
    ".advanced-search-form",
  )!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  fixture.detectChanges();
  expect(submitted).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Matrix" }),
  );
  fixture.componentInstance.toggle();
  fixture.detectChanges();
  fixture.componentInstance.clear();
  fixture.detectChanges();
  expect(submitted).toHaveBeenCalledTimes(1);
  expect(
    document.querySelector<HTMLInputElement>('[name="advanced-title"]')!.value,
  ).toBe("");
  fixture.destroy();
});

it("the library input survives route synchronisation and browser history restores the query", async () => {
  const params = new BehaviorSubject(convertToParamMap({}));
  const searchTerm = signal(""),
    searchFilters = signal({ live: true, movie: true, series: true });
  const results = signal([]),
    searching = signal(false);
  const store = {
    searchTerm,
    searchFilters,
    searchResults: results,
    isSearching: searching,
    setSearchTerm: (term: string) => searchTerm.set(term),
    setSearchFilters: (
      filters: typeof searchFilters extends () => infer T ? T : never,
    ) => searchFilters.set(filters),
    setIsSearching: (value: boolean) => searching.set(value),
    setGlobalSearchResults: (value: []) => results.set(value),
    setSelectedContentType: jest.fn(),
  };
  const route = {
    snapshot: {
      data: { layout: "workspace", isGlobalSearch: true },
      queryParamMap: convertToParamMap({}),
    },
    queryParamMap: params,
  };
  const navigate = jest.fn().mockResolvedValue(true);
  TestBed.configureTestingModule({
    imports: [SearchResultsComponent],
    providers: [
      { provide: XtreamStore, useValue: store },
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: { navigate } },
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
    set: {
      template: "",
      imports: [],
      providers: [
        { provide: UnifiedDiscoveryState, useValue: { update: jest.fn() } },
      ],
    },
  });
  const fixture = TestBed.createComponent(SearchResultsComponent);
  fixture.detectChanges();
  fixture.componentInstance.updateSearchTerm("Matrix");
  fixture.detectChanges();
  expect(searchTerm()).toBe("Matrix");
  expect(navigate).toHaveBeenCalledWith(
    [],
    expect.objectContaining({ queryParams: { q: "Matrix" }, replaceUrl: true }),
  );
  params.next(convertToParamMap({ q: "Alien" }));
  fixture.detectChanges();
  expect(searchTerm()).toBe("Alien");
  fixture.destroy();
});

it("Sources groups provider copies and keeps a precise manual choice available", async () => {
  const a = movie("a"),
    b = {
      ...a,
      identity: { ...a.identity, providerItemId: "8" },
      originalTitle: "Movie (2026) 4K",
      resolution: 2160,
    };
  const other = movie("b"),
    group = { key: "movie", versions: [a, b, other] };
  const state = {
    groups: signal([group]),
    choosing: signal(null),
    error: signal(null),
    rank: jest.fn().mockResolvedValue([b, a, other]),
    choose: jest.fn().mockResolvedValue(b),
    versionKey: (v: DiscoveryVersion) => JSON.stringify(v.identity),
  };
  TestBed.configureTestingModule({
    imports: [UnifiedDiscoveryResultsComponent],
    providers: [{ provide: UnifiedDiscoveryState, useValue: state }],
  });
  const fixture = TestBed.createComponent(UnifiedDiscoveryResultsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  fixture.debugElement.query(By.css(".version-count")).nativeElement.click();
  fixture.detectChanges();
  expect(fixture.debugElement.queryAll(By.css(".source-group"))).toHaveLength(
    2,
  );
  expect(fixture.debugElement.queryAll(By.css(".version-row"))).toHaveLength(1);
  fixture.debugElement.query(By.css(".source-options")).nativeElement.click();
  fixture.detectChanges();
  expect(fixture.debugElement.queryAll(By.css(".version-row"))).toHaveLength(3);
  fixture.debugElement
    .queryAll(By.css(".version-open"))[1]
    .nativeElement.click();
  await fixture.whenStable();
  expect(state.choose).toHaveBeenCalledWith(group, b);
  fixture.componentInstance.focus({ ...group, key: "another" });
  fixture.detectChanges();
  expect(fixture.debugElement.queryAll(By.css(".version-row"))).toHaveLength(0);
  fixture.destroy();
});

it("a grouped title shows its known year without changing the preferred playback version", async () => {
  const unknown = {
    ...movie("a"),
    work: { kind: "movie" as const, title: "Movie" },
    posterUrl: "/original-poster.jpg",
    description: "The original source synopsis",
  };
  const dated = {
    ...movie("b"),
    work: { kind: "movie" as const, title: "Movie" },
    displayYear: 2026,
  };
  const group = { key: "movie", versions: [unknown, dated] };
  const later = {
    ...movie("c"),
    originalTitle: "Later title",
    work: { kind: "movie" as const, title: "Later title" },
    displayYear: 2027,
  };
  const laterGroup = { key: "later", versions: [later] };
  const state = {
    groups: signal([group, laterGroup]),
    choosing: signal(null),
    error: signal(null),
    rank: jest.fn().mockResolvedValue([unknown, dated]),
    choose: jest.fn().mockResolvedValue(unknown),
    versionKey: (v: DiscoveryVersion) => v.identity.playlistId,
  };
  TestBed.configureTestingModule({
    imports: [UnifiedDiscoveryResultsComponent],
    providers: [{ provide: UnifiedDiscoveryState, useValue: state }],
  });
  const fixture = TestBed.createComponent(UnifiedDiscoveryResultsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(
    fixture.nativeElement.querySelector(".poster-meta").textContent,
  ).toContain("2026");
  expect(
    fixture.nativeElement.querySelector(".work-meta").textContent,
  ).toContain("2026");
  expect(fixture.nativeElement.textContent).not.toContain("Year unknown");
  expect(
    fixture.nativeElement.querySelector(".poster-art img").getAttribute("src"),
  ).toBe("/original-poster.jpg");
  expect(
    fixture.nativeElement.querySelector(".synopsis").textContent,
  ).toContain("The original source synopsis");
  expect(fixture.componentInstance.preferred()).toBe(unknown);
  expect(
    fixture.componentInstance.displayVersion(group).work?.releaseYear,
  ).toBeUndefined();
  expect(group.versions).toEqual([unknown, dated]);
  fixture.componentInstance.sort.set("year");
  fixture.detectChanges();
  expect(
    Array.from(
      fixture.nativeElement.querySelectorAll(".poster-select strong"),
    ).map((node: HTMLElement) => node.textContent?.trim()),
  ).toEqual(["Later title", "Movie"]);
  fixture.nativeElement.querySelector(".auto-open").click();
  await fixture.whenStable();
  expect(state.choose).toHaveBeenCalledWith(group, undefined);
  fixture.destroy();
});
