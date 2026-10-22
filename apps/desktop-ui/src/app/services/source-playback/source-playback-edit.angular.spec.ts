/* eslint-disable @nx/enforce-module-boundaries -- Exercise the actual source editor and persistence boundary together. */
import { PlaylistInfoComponent } from "../../../../../../libs/providers/shared/playlist-ui/src/lib/recent-playlists/playlist-info/playlist-info.component";
import { PlaylistsService } from "@arm-nator/services";
import { firstValueFrom, of } from "rxjs";
const source = {
  _id: "one",
  title: "Fixture",
  serverUrl: "https://fixture.test",
  username: "old",
  password: "old",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
}
it("drains active checks before the editor writes Xtream credentials", async () => {
  const gate = deferred<() => void>(),
    release = jest.fn(),
    write = jest.fn(async () => true);
  const editor = Object.assign(Object.create(PlaylistInfoComponent.prototype), {
    playlist: source,
    sourceChecks: { beginSourceOperation: jest.fn(() => gate.promise) },
    runtime: { supportsXtreamSqliteDataSource: true },
    databaseService: { updateXtreamPlaylistDetails: write },
    store: { dispatch: jest.fn() },
    snackBar: { open: jest.fn() },
    translate: { instant: (s: string) => s },
    dialogRef: null,
  });
  const task = editor.saveChanges({ ...source, password: "new" });
  expect(write).not.toHaveBeenCalled();
  gate.resolve(release);
  await task;
  expect(write).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
it("holds source edits through the actual metadata persistence acknowledgement", async () => {
  const gate = deferred<() => void>(),
    saved = deferred<unknown>(),
    release = jest.fn(),
    write = jest.fn(() => saved.promise);
  const playlists = Object.assign(Object.create(PlaylistsService.prototype), {
    playlistWriteQueues: new Map(),
    sourceInjector: {
      get: () => ({ beginSourceOperation: () => gate.promise }),
    },
    getPlaylistById: () => of(source),
    persistPlaylistMutation: write,
  });
  const task = firstValueFrom(
    playlists.updatePlaylistMeta({ ...source, password: "new" }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(write).not.toHaveBeenCalled();
  gate.resolve(release);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(release).not.toHaveBeenCalled();
  saved.resolve(source);
  await task;
  expect(write).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
