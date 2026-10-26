// 手機分類快篩卡的狀態與 history 處理。
// 手機（< 768px）點分類圖表時開底部快篩卡，取代直接套用列表篩選；斷點變化即時反映。
// 沿用活動明細抽屜的 history.pushState 模式，讓返回手勢／返回鍵可以關卡片；卡片開著時再開
// 活動明細會疊在上面，關明細會回到卡片仍開著的狀態。需在元件初始化時呼叫。
import { onMount, tick } from "svelte";
import type { ActivityCategorySlice } from "./chart";
import type { ActivityCategoryFilter } from "./filter";

type SheetFlow = "income" | "expense";

export function createCategorySheet({
  getSlices,
  chooseCategory,
  isCategorySelected,
  getListElement,
}: {
  /** 目前月份對應收支別的圓餅切片。 */
  getSlices: (flow: SheetFlow) => ActivityCategorySlice[];
  /** 在列表中套用分類篩選（桌面點圖表、卡片的「在列表中篩選」共用）。 */
  chooseCategory: (flow: SheetFlow, category: string) => void;
  /** 列表目前是否已套用這個分類篩選（chooseCategory 對同一分類會切換成取消）。 */
  isCategorySelected: (flow: SheetFlow, category: string) => boolean;
  getListElement: () => HTMLElement | undefined;
}) {
  let isMobileViewport = $state(false);
  onMount(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => {
      isMobileViewport = query.matches;
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });
  /** 手機分類快篩卡目前開啟的分類（null＝未開啟）；桌面永遠不使用。 */
  let key = $state<ActivityCategoryFilter | null>(null);
  /** 手機分類快篩卡目前對應的切片；找不到（例如資料剛好變動）就不顯示卡片內容。 */
  const slice = $derived(
    key
      ? getSlices(key.flow).find(
          (candidate) => candidate.category === key!.category,
        )
      : undefined,
  );
  function open(flow: SheetFlow, category: string) {
    if (key?.flow === flow && key.category === category) return;
    key = { flow, category };
    // 推入純物件，不能放 $state proxy：History.pushState 無法 structured-clone
    // 反應式 Proxy（會拋 DataCloneError）。
    window.history.pushState(
      { ...window.history.state, categorySheet: { flow, category } },
      "",
    );
  }
  function close() {
    if (window.history.state?.categorySheet) window.history.back();
    else key = null;
  }
  function handleCategorySelect(flow: SheetFlow, category: string) {
    if (isMobileViewport) {
      open(flow, category);
      return;
    }
    chooseCategory(flow, category);
  }
  function applyFilter() {
    if (!key) return;
    if (!isCategorySelected(key.flow, key.category))
      chooseCategory(key.flow, key.category);
    const scrollToList = () =>
      void tick().then(() => {
        getListElement()?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    if (window.history.state?.categorySheet) {
      // 返回是非同步的，瀏覽器還原捲動位置會蓋掉先做的捲動；等返回完成的下一個 frame 再捲到列表。
      window.addEventListener(
        "popstate",
        () => requestAnimationFrame(scrollToList),
        { once: true },
      );
      window.history.back();
    } else {
      key = null;
      scrollToList();
    }
  }
  return {
    get isMobileViewport() {
      return isMobileViewport;
    },
    get key() {
      return key;
    },
    set key(next: ActivityCategoryFilter | null) {
      key = next;
    },
    get slice() {
      return slice;
    },
    close,
    handleCategorySelect,
    applyFilter,
  };
}

export type CategorySheet = ReturnType<typeof createCategorySheet>;
