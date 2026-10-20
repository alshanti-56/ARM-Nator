import { Component, ChangeDetectionStrategy } from "@angular/core";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import { SearchResultsComponent } from "../search-results/search-results.component";

@Component({
  selector: "app-global-search-results",
  imports: [SearchResultsComponent],
  providers: [XtreamStore],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: "<app-search-results/>",
})
export class GlobalSearchResultsComponent {}
