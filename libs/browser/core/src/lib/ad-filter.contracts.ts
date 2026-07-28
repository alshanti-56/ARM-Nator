export type AdFilterDecision = "allow" | "block" | "redirect";

export interface AdFilterRequest {
  readonly url: string;
  readonly resourceType: string;
  readonly initiator?: string;
  readonly tabId?: string;
}

export interface AdFilterResult {
  readonly decision: AdFilterDecision;
  readonly redirectUrl?: string;
  readonly matchedRule?: string;
}

export interface AdFilterStats {
  readonly blocked: number;
  readonly allowed: number;
  readonly redirected: number;
}

export interface AdFilterEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  evaluate(request: AdFilterRequest): AdFilterResult;
  update(): Promise<void>;
  getStats(): AdFilterStats;
}
