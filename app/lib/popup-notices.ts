import { getSqlite } from "./sqlite";

export type PopupNotice = {
  id: number;
  title: string;
  imageUrl: string;
  link: string;
  enabled: boolean;
  sortOrder: number;
};

type NoticeInput = Omit<PopupNotice, "id">;
type NoticeRow = Omit<PopupNotice, "enabled"> & { enabled: number };
const columns = "id, title, image_url AS imageUrl, link, enabled, sort_order AS sortOrder";

function asNotice(row: NoticeRow): PopupNotice {
  return { ...row, enabled: row.enabled === 1 };
}

function readNotices(enabledOnly: boolean): PopupNotice[] {
  const where = enabledOnly ? "WHERE enabled = 1" : "";
  const rows = getSqlite().prepare(`SELECT ${columns} FROM popup_notices ${where} ORDER BY sort_order, id`).all() as NoticeRow[];
  return rows.map(asNotice);
}

export function readAdminPopupNotices(): PopupNotice[] {
  return readNotices(false);
}

export function readPublicPopupNotices(): PopupNotice[] {
  return readNotices(true);
}

export function createPopupNotice(input: NoticeInput): PopupNotice {
  const row = getSqlite().prepare(`INSERT INTO popup_notices (title, image_url, link, enabled, sort_order)
    VALUES (?, ?, ?, ?, ?) RETURNING ${columns}`)
    .get(input.title, input.imageUrl, input.link, Number(input.enabled), input.sortOrder) as NoticeRow;
  return asNotice(row);
}

export function updatePopupNotice(input: PopupNotice): PopupNotice | null {
  const row = getSqlite().prepare(`UPDATE popup_notices SET title = ?, image_url = ?, link = ?, enabled = ?, sort_order = ?
    WHERE id = ? RETURNING ${columns}`)
    .get(input.title, input.imageUrl, input.link, Number(input.enabled), input.sortOrder, input.id) as NoticeRow | undefined;
  return row ? asNotice(row) : null;
}

export function deletePopupNotice(id: number): boolean {
  return Boolean(getSqlite().prepare("DELETE FROM popup_notices WHERE id = ?").run(id).changes);
}
