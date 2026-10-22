import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type WritableSignal,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MAT_DIALOG_DATA, MatDialogModule } from "@angular/material/dialog";
import { MatIconModule } from "@angular/material/icon";
import { MatTabsModule } from "@angular/material/tabs";
import { TranslatePipe } from "@ngx-translate/core";
import type {
  ContentMetadataSource,
  MetadataDisplayEntry,
} from "@arm-nator/shared/interfaces";
import { MetadataSourceToggleComponent } from "./metadata-source-toggle.component";

export interface ContentMetadataDialogData {
  title: string;
  mediaType?: "movie" | "tv";
  entries: MetadataDisplayEntry[];
  metadataSource?: WritableSignal<ContentMetadataSource>;
  hasTmdb?: () => boolean;
  providerEntries?: () => MetadataDisplayEntry[];
  tmdbEntries?: () => MetadataDisplayEntry[];
  displayEntries?: () => MetadataDisplayEntry[];
}

@Component({
  selector: "app-content-metadata-dialog",
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatTabsModule,
    TranslatePipe,
    MetadataSourceToggleComponent,
  ],
  templateUrl: "./content-metadata-dialog.component.html",
  styleUrl: "./content-metadata-dialog.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentMetadataDialogComponent {
  readonly data = inject<ContentMetadataDialogData>(MAT_DIALOG_DATA);
  readonly metadataSource =
    this.data.metadataSource ?? signal<ContentMetadataSource>("provider");
  readonly hasTmdb = computed(() => this.data.hasTmdb?.() ?? false);
  readonly activeSource = computed(() =>
    this.hasTmdb() && this.metadataSource() === "tmdb" ? "tmdb" : "provider",
  );
  readonly query = signal("");
  readonly entries = computed(() =>
    this.activeSource() === "tmdb"
      ? (this.data.tmdbEntries?.() ?? this.data.entries)
      : (this.data.providerEntries?.() ?? this.data.entries),
  );
  readonly displayEntries = computed(
    () => this.data.displayEntries?.() ?? this.entries(),
  );
  readonly fields = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.entries().filter((entry) =>
      `${entry.key} ${entry.label} ${entry.value}`
        .toLocaleLowerCase()
        .includes(query),
    );
  });
  readonly title = computed(
    () => this.value("name", "title") || this.data.title,
  );
  readonly originalTitle = computed(() =>
    this.value("o_name", "original_title", "original_name"),
  );
  readonly synopsis = computed(() =>
    this.value("description", "plot", "overview"),
  );
  readonly facts = computed(() =>
    this.rows([
      [
        "XTREAM.RELEASE_DATE",
        "releasedate",
        "releaseDate",
        "release_date",
        "first_air_date",
      ],
      ["XTREAM.METADATA.RUNTIME", "duration", "episode_run_time", "runtime"],
      ["XTREAM.RATING", "rating", "rating_imdb", "vote_average"],
      ["XTREAM.AGE_RATING", "age", "mpaa_rating"],
    ]),
  );
  readonly overview = computed(() =>
    this.rows([
      ["XTREAM.METADATA.GENRES", "genre"],
      ["XTREAM.DIRECTOR", "director"],
      ["XTREAM.METADATA.COUNTRY", "country"],
      ["XTREAM.CAST", "cast", "actors"],
    ]),
  );
  readonly mediaSections = computed(() => {
    const provider = this.data.providerEntries?.() ?? this.data.entries;
    return ["video", "audio"].flatMap((key) => {
      const entry = provider.find((field) => field.key === key);
      if (!entry) return [];
      try {
        const parsed = JSON.parse(entry.value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
          return [];
        const labels: Record<string, string> = {
          codec_name: "Codec",
          profile: "Profile",
          display_aspect_ratio: "Aspect ratio",
          pix_fmt: "Pixel format",
          r_frame_rate: "Frame rate",
          channels: "Channels",
          channel_layout: "Channel layout",
          sample_rate: "Sample rate",
        };
        const allowed =
          key === "video"
            ? [
                "codec_name",
                "profile",
                "display_aspect_ratio",
                "pix_fmt",
                "r_frame_rate",
              ]
            : [
                "codec_name",
                "profile",
                "channels",
                "channel_layout",
                "sample_rate",
              ];
        const rows = allowed
          .filter(
            (field) =>
              parsed[field] !== undefined &&
              parsed[field] !== null &&
              parsed[field] !== "",
          )
          .map((field) => {
            let value = String(parsed[field]);
            if (field === "sample_rate" && Number(value) > 0)
              value = Number(value).toLocaleString() + " Hz";
            if (field === "r_frame_rate") {
              const [numerator, denominator = "1"] = value
                .split("/")
                .map(String);
              const fps = Number(numerator) / Number(denominator);
              if (Number.isFinite(fps) && fps > 0)
                value = String(Math.round(fps * 1000) / 1000) + " fps";
            }
            return { label: labels[field], value };
          });
        if (key === "video" && parsed.width && parsed.height) {
          rows.splice(Math.min(2, rows.length), 0, {
            label: "Resolution",
            value: `${parsed.width} × ${parsed.height}`,
          });
        }
        return rows.length ? [{ key, rows }] : [];
      } catch {
        return [];
      }
    });
  });
  readonly fileFields = computed(() => {
    const provider = this.data.providerEntries?.() ?? this.data.entries;
    const labels: Record<string, string> = {
      duration: "XTREAM.DURATION",
      duration_secs: "XTREAM.METADATA.RUNTIME_SECONDS",
      bitrate: "XTREAM.BITRATE",
      "movie_data.stream_id": "XTREAM.STREAM_ID",
      "movie_data.container_extension": "XTREAM.FORMAT",
      "movie_data.category_id": "XTREAM.CATEGORY_ID",
    };
    return provider
      .filter(
        (entry) =>
          labels[entry.key] &&
          !(
            entry.key === "duration_secs" &&
            provider.some((field) => field.key === "duration")
          ),
      )
      .map((entry) => ({ ...entry, label: labels[entry.key] }));
  });
  readonly links = computed(() => {
    const id = this.value("tmdb_id", "id");
    const trailer = this.value("youtube_trailer");
    const result: { label: string; url: string }[] = [];
    if (/^\d+$/.test(id))
      result.push({
        label: "TMDB",
        url: `https://www.themoviedb.org/${this.data.mediaType ?? "movie"}/${id}`,
      });
    if (/^[\w-]{11}$/.test(trailer))
      result.push({
        label: "XTREAM.METADATA.TRAILER",
        url: `https://www.youtube.com/watch?v=${trailer}`,
      });
    return result;
  });

  private value(...keys: string[]): string {
    for (const key of keys) {
      const found = this.displayEntries().find(
        (entry) => entry.key.toLowerCase() === key.toLowerCase(),
      );
      if (found?.value.trim()) return found.value;
    }
    return "";
  }
  private rows(definitions: string[][]): { label: string; value: string }[] {
    return definitions.flatMap(([label, ...keys]) => {
      const value = this.value(...keys);
      return value ? [{ label, value }] : [];
    });
  }
  isExpandable(entry: MetadataDisplayEntry): boolean {
    return /^[\[{]/.test(entry.value.trim()) || entry.value.length > 200;
  }
  formattedValue(entry: MetadataDisplayEntry): string {
    try {
      return JSON.stringify(JSON.parse(entry.value), null, 2);
    } catch {
      return entry.value;
    }
  }
  safeLink(value: string): string | null {
    return /^https?:\/\/[^\s,]+$/i.test(value) ? value : null;
  }
}
