import { getSqlite } from "./sqlite";

export type TelegramKeywordRule = {
  id: number;
  keyword: string;
  matchMode: "exact" | "contains";
  response: string;
  showButton: boolean;
};

type KeywordInput = Omit<TelegramKeywordRule, "id" | "showButton"> & { showButton?: boolean };
type KeywordRow = Omit<TelegramKeywordRule, "showButton"> & { showButton: number };
const ruleColumns = "id, keyword, match_mode AS matchMode, response, show_button AS showButton";
const publicRule = (rule: KeywordRow): TelegramKeywordRule => ({ ...rule, showButton: rule.showButton === 1 });

export function normalizeTelegramKeyword(text: string) {
  return text.normalize("NFKC").trim().toLowerCase();
}

export function listTelegramKeywordRules(): TelegramKeywordRule[] {
  const rules = getSqlite().prepare(`SELECT ${ruleColumns} FROM telegram_keyword_rules ORDER BY id`).all() as KeywordRow[];
  return rules.map(publicRule);
}

export function createTelegramKeywordRule(input: KeywordInput): TelegramKeywordRule {
  const rule = getSqlite().prepare(`INSERT INTO telegram_keyword_rules (keyword, keyword_key, match_mode, response, show_button)
    VALUES (?, ?, ?, ?, ?) RETURNING ${ruleColumns}`)
    .get(input.keyword, normalizeTelegramKeyword(input.keyword), input.matchMode, input.response, Number(input.showButton ?? true)) as KeywordRow;
  return publicRule(rule);
}

export function updateTelegramKeywordRule(id: number, input: KeywordInput): TelegramKeywordRule | null {
  const rule = getSqlite().prepare(`UPDATE telegram_keyword_rules SET keyword = ?, keyword_key = ?, match_mode = ?, response = ?, show_button = COALESCE(?, show_button)
    WHERE id = ? RETURNING ${ruleColumns}`)
    .get(input.keyword, normalizeTelegramKeyword(input.keyword), input.matchMode, input.response, input.showButton === undefined ? null : Number(input.showButton), id) as KeywordRow | undefined;
  return rule ? publicRule(rule) : null;
}

export function deleteTelegramKeywordRule(id: number): boolean {
  return Boolean(getSqlite().prepare("DELETE FROM telegram_keyword_rules WHERE id = ?").run(id).changes);
}
