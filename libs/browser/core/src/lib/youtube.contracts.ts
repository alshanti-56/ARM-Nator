export interface YouTubeVideoTarget {
  readonly videoId: string;
  readonly url: string;
  readonly playlistId?: string;
  readonly startSeconds?: number;
}

export interface YouTubeSessionOptions {
  readonly blockAds: boolean;
  readonly sponsorBlock: boolean;
  readonly autoplay: boolean;
}

export interface YouTubeSession {
  readonly tabId: string;
  readonly target: YouTubeVideoTarget;
  readonly options: YouTubeSessionOptions;
}
