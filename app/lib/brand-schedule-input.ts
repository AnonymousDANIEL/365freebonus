import { isValidPromotionStart, type Brand } from "./directory";

const malaysiaOffset = 8 * 60 * 60 * 1000;
type OriginalSchedule = Pick<Brand, "promotionStartsAt" | "published">;

export function malaysiaDateTimeInput(start: number | null | undefined): string {
  return isValidPromotionStart(start) ? new Date(start + malaysiaOffset).toISOString().slice(0, -8) : "";
}

/** Preserve explicit publishing intent; the server is authoritative about time. */
export function brandScheduleInput(
  editing: Pick<Brand, "category" | "published">,
  original: OriginalSchedule | undefined,
  input: string,
): { promotionStartsAt?: number | null; autoPublishAtStart?: true } {
  if (editing.category === "All") return {};
  const changed = input !== malaysiaDateTimeInput(original?.promotionStartsAt);
  let start: number | null = null;
  if (input) {
    const parsed = Date.parse(`${input}+08:00`);
    if (!isValidPromotionStart(parsed) || malaysiaDateTimeInput(parsed) !== input) {
      throw new Error("请输入有效的开始日期和时间，留空则立即开始。");
    }
    start = changed ? parsed : original?.promotionStartsAt ?? parsed;
  }
  const explicitlyPublishesDraft = !original?.published && editing.published;
  const schedules = start !== null && (changed || explicitlyPublishesDraft)
    && (!original?.published || editing.published);
  return {
    ...(changed || schedules ? { promotionStartsAt: start } : {}),
    ...(schedules ? { autoPublishAtStart: true as const } : {}),
  };
}
