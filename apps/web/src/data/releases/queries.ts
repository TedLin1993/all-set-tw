import { queryOptions } from "@tanstack/svelte-query";
import { queryKeys } from "@/shared/api/query-keys";
import bundledReleases from "../../../../../releases.json";

export type Release = (typeof bundledReleases)[number];
export const currentVersion = bundledReleases[0].version;
const cacheDuration = 6 * 60 * 60 * 1000;
const versionOrder = new Intl.Collator("en", { numeric: true });

// 規則與 .github/workflows/release.yml 的驗證一致，修改時需一起調整。
function isRelease(value: unknown): value is Release {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    /^\d+\.\d+\.\d+$/.test(value.version) &&
    "date" in value &&
    typeof value.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    "changes" in value &&
    Array.isArray(value.changes) &&
    value.changes.every((change: unknown) => typeof change === "string")
  );
}

export const releasesQuery = queryOptions({
  queryKey: queryKeys.releases,
  staleTime: cacheDuration,
  gcTime: cacheDuration,
  queryFn: async ({ signal }): Promise<Release[]> => {
    const { repository, branch } = __BUILD_INFO__;
    const response = await fetch(
      `https://raw.githubusercontent.com/${repository}/${branch}/releases.json`,
      { signal, credentials: "omit", referrerPolicy: "no-referrer" },
    );
    if (!response.ok)
      throw new Error(`無法取得版本紀錄（HTTP ${response.status}）`);
    const data: unknown = await response.json();
    if (!Array.isArray(data) || !data.length || !data.every(isRelease))
      throw new Error("版本紀錄格式錯誤");
    return data;
  },
});

export function releaseHistory(upstream: Release[] = []): Release[] {
  const versions = new Map<string, Release>();
  for (const release of [...bundledReleases, ...upstream])
    versions.set(release.version, release);
  return [...versions.values()].sort((a, b) =>
    versionOrder.compare(b.version, a.version),
  );
}
