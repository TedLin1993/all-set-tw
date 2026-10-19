import { queryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type {
  AiClassificationStatus,
  ClassificationCategoryRow,
  ClassificationRuleRow,
} from "./types";

type ApiProvider = () => ApiClient;

export const classificationRulesQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.classificationRules,
    queryFn: () =>
      getApi().get<ClassificationRuleRow[]>("/api/classification/rules"),
  });

export const classificationCategoriesQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.classificationCategories,
    queryFn: () =>
      getApi().get<ClassificationCategoryRow[]>(
        "/api/classification/categories",
      ),
  });

export const aiClassificationQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.aiClassification,
    queryFn: () =>
      getApi().get<AiClassificationStatus>("/api/classification/ai"),
    // Follow a running scan; the Queue processes it in the background.
    refetchInterval: (query) => (query.state.data?.scanning ? 5_000 : false),
  });
