import { inject } from "@angular/core";
import { Router, Routes } from "@angular/router";
import { RuntimeCapabilitiesService, SettingsStore } from "@arm-nator/services";
import { WorkspaceStartupPreferencesService } from "@arm-nator/workspace/shell/util";

const settingsReadyResolver = () => inject(SettingsStore).loadSettings();

const workspaceEntryRedirect = async () =>
  inject(WorkspaceStartupPreferencesService).resolveInitialWorkspacePath();

const dashboardAccessGuard = async () => {
  const startupPreferences = inject(WorkspaceStartupPreferencesService);
  const router = inject(Router);
  const redirectPath = await startupPreferences.resolveDashboardPath();

  return redirectPath === "/workspace/dashboard"
    ? true
    : router.parseUrl(redirectPath);
};

export function resolveElectronOnlyGlobalSearchRoute(
  runtime: Pick<RuntimeCapabilitiesService, "isElectron">,
  router: Pick<Router, "parseUrl">,
) {
  return runtime.isElectron ? true : router.parseUrl("/workspace/sources");
}

const electronOnlyGlobalSearchGuard = () => {
  return resolveElectronOnlyGlobalSearchRoute(
    inject(RuntimeCapabilitiesService),
    inject(Router),
  );
};

export const routes: Routes = [
  {
    path: "",
    pathMatch: "full",
    redirectTo: "workspace",
  },
  {
    path: "workspace",
    data: {
      layout: "workspace",
    },
    resolve: {
      settingsReady: settingsReadyResolver,
    },
    loadComponent: () =>
      import("@arm-nator/workspace/shell/feature").then(
        (c) => c.WorkspaceShellComponent,
      ),
    children: [
      {
        path: "",
        pathMatch: "full",
        redirectTo: workspaceEntryRedirect,
      },
      {
        path: "dashboard",
        canActivate: [dashboardAccessGuard],
        loadComponent: () =>
          import("@arm-nator/workspace/dashboard/feature").then(
            (c) => c.WorkspaceDashboardRailsComponent,
          ),
      },
      {
        path: "sources",
        loadComponent: () =>
          import("@arm-nator/workspace/shell/feature").then(
            (c) => c.WorkspaceSourcesComponent,
          ),
      },
      {
        path: "tools/direct-play",
        loadComponent: () =>
          import("@arm-nator/tools/feature").then((c) => c.DirectPlayComponent),
      },
      {
        path: "playlists/:id",
        loadChildren: () =>
          import("@arm-nator/providers/m3u/feature-player").then((m) =>
            m.createM3uWorkspaceRoutes(),
          ),
      },
      {
        path: "global-favorites",
        data: {
          mode: "favorites",
          defaultScope: "all",
        },
        loadComponent: () =>
          import("./global-collection-route.component").then(
            (c) => c.GlobalCollectionRouteComponent,
          ),
      },
      {
        path: "global-recent",
        data: {
          mode: "recent",
          defaultScope: "all",
        },
        loadComponent: () =>
          import("./global-collection-route.component").then(
            (c) => c.GlobalCollectionRouteComponent,
          ),
      },
      {
        path: "search",
        canActivate: [electronOnlyGlobalSearchGuard],
        data: {
          isGlobalSearch: true,
        },
        loadComponent: () =>
          import("@arm-nator/providers/xtream/feature").then(
            (c) => c.GlobalSearchResultsComponent,
          ),
      },
      {
        path: "",
        loadChildren: () =>
          import("@arm-nator/providers/xtream/feature").then((m) =>
            m.createXtreamRoutes(),
          ),
      },
      {
        path: "settings",
        loadComponent: () =>
          import("@arm-nator/settings/ui").then((c) => c.SettingsComponent),
      },
    ],
  },
  {
    path: "settings",
    redirectTo: "/workspace/settings",
    pathMatch: "full",
  },
  {
    path: "**",
    redirectTo: "",
  },
];
