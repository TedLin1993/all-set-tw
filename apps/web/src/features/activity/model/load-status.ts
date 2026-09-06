export interface ActivityDataSourceSnapshot {
  label: string;
  isError: boolean;
}

export interface ActivityDataStatus {
  failedLabels: string[];
  hasFailure: boolean;
}

export function getActivityDataStatus(
  sources: readonly ActivityDataSourceSnapshot[],
): ActivityDataStatus {
  const failed = sources.filter((source) => source.isError);

  return {
    failedLabels: failed.map((source) => source.label),
    hasFailure: failed.length > 0,
  };
}
