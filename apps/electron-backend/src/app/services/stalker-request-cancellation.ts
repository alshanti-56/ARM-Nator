/** Renderer-owned cancellation leases; no renderer can cancel another renderer's request. */
export class StalkerRequestCancellation {
  private owners = new Map<number, Map<string, AbortController>>();
  constructor(private readonly limitPerOwner = 64) {}
  begin(
    owner: number,
    requestId?: string,
  ): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    if (requestId === undefined)
      return { signal: controller.signal, release: () => undefined };
    if (
      typeof requestId !== "string" ||
      !requestId.trim() ||
      requestId.length > 128
    )
      throw new Error("Invalid portal request ID");
    const requests =
      this.owners.get(owner) ?? new Map<string, AbortController>();
    if (requests.has(requestId))
      throw new Error("Portal request ID already active");
    if (requests.size >= this.limitPerOwner)
      throw new Error("Portal request concurrency limit exceeded");
    requests.set(requestId, controller);
    this.owners.set(owner, requests);
    return {
      signal: controller.signal,
      release: () => {
        if (requests.get(requestId) === controller) requests.delete(requestId);
        if (!requests.size && this.owners.get(owner) === requests)
          this.owners.delete(owner);
      },
    };
  }
  cancel(owner: number, requestId: string): boolean {
    const controller = this.owners.get(owner)?.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
  cancelOwner(owner: number): void {
    for (const controller of this.owners.get(owner)?.values() ?? [])
      controller.abort();
    this.owners.delete(owner);
  }
}
