/** Keep local browsing independent of a slow or unavailable account endpoint. */
export async function bootstrapCachedSection<T>(operations: {
  hasCache: () => Promise<boolean>;
  hydrate: () => Promise<void>;
  authenticate: () => Promise<T>;
  isCurrent?: () => boolean;
}): Promise<{ cached: boolean; status: T | null }> {
  // Observe rejection even when a cached section returns before the request settles.
  const account = operations.authenticate().then(
    (status) => ({ status }),
    (error) => ({ error }),
  );
  const cached = await operations.hasCache();
  if (operations.isCurrent?.() === false)
    return { cached: false, status: null };
  if (cached) {
    await operations.hydrate();
    return { cached: true, status: null };
  }
  const result = await account;
  if ("error" in result) throw result.error;
  return { cached: false, status: result.status };
}
