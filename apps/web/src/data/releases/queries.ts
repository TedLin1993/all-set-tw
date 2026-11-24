import { queryOptions } from "@tanstack/svelte-query";
import { queryKeys } from "@/shared/api/query-keys";
import releasesJson from "../../../../../releases.json";

export interface ReleaseImage {
  /** 圖片說明的 changes 索引，顯示在該條摘要下方。 */
  change: number;
  /** 上游 repository 內的圖片路徑，例如 `images/releases/1.3.0-example.png`。 */
  src: string;
  alt: string;
}

export interface Release {
  version: string;
  date: string;
  changes: string[];
  images?: ReleaseImage[];
}

const bundledReleases: Release[] = releasesJson;
export const currentVersion = bundledReleases[0].version;
const cacheDuration = 6 * 60 * 60 * 1000;
const versionOrder = new Intl.Collator("en", { numeric: true });

/** 上游 repository 追蹤分支上的檔案；版本紀錄與更新圖片都從這裡讀取。 */
export function upstreamFileUrl(path: string) {
  const { repository, branch } = __BUILD_INFO__;
  return `https://raw.githubusercontent.com/${repository}/${branch}/${path}`;
}

// 規則與 .github/workflows/release.yml 的驗證一致，修改時需一起調整。
function isReleaseImageList(
  value: unknown,
  changeCount: number,
): value is ReleaseImage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (image: unknown) =>
        typeof image === "object" &&
        image !== null &&
        "change" in image &&
        typeof image.change === "number" &&
        Number.isInteger(image.change) &&
        image.change >= 0 &&
        image.change < changeCount &&
        "src" in image &&
        typeof image.src === "string" &&
        /^images\/releases\/[A-Za-z0-9._-]+\.(png|jpg|webp)$/.test(image.src) &&
        "alt" in image &&
        typeof image.alt === "string" &&
        image.alt.length > 0,
    )
  );
}

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
    value.changes.every((change: unknown) => typeof change === "string") &&
    (!("images" in value) ||
      isReleaseImageList(value.images, value.changes.length))
  );
}

export const releasesQuery = queryOptions({
  queryKey: queryKeys.releases,
  staleTime: cacheDuration,
  gcTime: cacheDuration,
  queryFn: async ({ signal }): Promise<Release[]> => {
    const response = await fetch(upstreamFileUrl("releases.json"), {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
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
