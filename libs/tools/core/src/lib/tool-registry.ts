export const DESKTOP_TOOL_IDS = {
  CredentialTester: "credential-tester",
  DirectPlay: "direct-play",
  Browser: "browser",
  YouTube: "youtube",
} as const;

export type DesktopToolId =
  (typeof DESKTOP_TOOL_IDS)[keyof typeof DESKTOP_TOOL_IDS];

export interface DesktopToolDescriptor {
  readonly id: DesktopToolId;
  readonly route: string;
  readonly labelKey: string;
  readonly icon: string;
  readonly enabled: boolean;
}

export const DESKTOP_TOOL_ROUTES = {
  CredentialTester: "/workspace/tools/credentials",
  DirectPlay: "/workspace/tools/direct-play",
  Browser: "/workspace/browser",
  YouTube: "/workspace/youtube",
} as const;
