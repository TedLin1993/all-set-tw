declare const __BUILD_INFO__: {
  repository: string;
  commit: string;
  branch: string;
  builtAt: string;
  cloudflareBuildId: string | null;
  cloudflareWorkerName: string | null;
  /** cloudflare：重新部署即可更新；repository：由部署 repository 管理版本；null：本機建置。 */
  updateMethod: "cloudflare" | "repository" | null;
};
