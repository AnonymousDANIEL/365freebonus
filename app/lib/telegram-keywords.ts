import { getSqlite } from "./sqlite";

export type TelegramKeywordRule = {
  id: number;
  keyword: string;
  matchMode: "exact" | "contains";
  response: string;
};

type KeywordInput = Omit<TelegramKeywordRule, "id">;
const ruleColumns = "id, keyword, match_mode AS matchMode, response";

export function normalizeTelegramKeyword(text: string) {
  return text.normalize("NFKC").trim().toLowerCase();
}

export function listTelegramKeywordRules(): TelegramKeywordRule[] {
  const rules = getSqlite().prepare(`SELECT ${ruleColumns} FROM telegram_keyword_rules ORDER BY id`).all() as TelegramKeywordRule[];
  return rules.map(rule => ({ ...rule }));
}

export function createTelegramKeywordRule(input: KeywordInput): TelegramKeywordRule {
  const rule = getSqlite().prepare(`INSERT INTO telegram_keyword_rules (keyword, keyword_key, match_mode, response)
    VALUES (?, ?, ?, ?) RETURNING ${ruleColumns}`)
    .get(input.keyword, normalizeTelegramKeyword(input.keyword), input.matchMode, input.response) as TelegramKeywordRule;
  return { ...rule };
}

export function updateTelegramKeywordRule(id: number, input: KeywordInput): TelegramKeywordRule | null {
  const rule = getSqlite().prepare(`UPDATE telegram_keyword_rules SET keyword = ?, keyword_key = ?, match_mode = ?, response = ?
    WHERE id = ? RETURNING ${ruleColumns}`)
    .get(input.keyword, normalizeTelegramKeyword(input.keyword), input.matchMode, input.response, id) as TelegramKeywordRule | undefined;
  return rule ? { ...rule } : null;
}

export function deleteTelegramKeywordRule(id: number): boolean {
  return Boolean(getSqlite().prepare("DELETE FROM telegram_keyword_rules WHERE id = ?").run(id).changes);
}
