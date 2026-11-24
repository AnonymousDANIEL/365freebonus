export const GAME_TIPS_CAPTION_PRESETS = [
  { id: "news-update", label: "News Update Game Tips", body: "See this edition’s featured games and browse the latest listings." },
  { id: "featured-selection", label: "Featured Game Picks", body: "Take a look at the featured lineup and explore more games from this platform." },
  { id: "bonus-roundup", label: "Game Tips & Bonus Roundup", body: "Browse this edition’s game picks and check the latest offers and their terms." },
] as const;

export const DEFAULT_GAME_TIPS_CAPTION_PRESET_ID = GAME_TIPS_CAPTION_PRESETS[0].id;

export function isGameTipsCaptionPresetId(value: unknown): value is (typeof GAME_TIPS_CAPTION_PRESETS)[number]["id"] {
  return GAME_TIPS_CAPTION_PRESETS.some(item => item.id === value);
}

export function gameTipsCaption(provider: string, presetId?: string | null): string {
  const preset = GAME_TIPS_CAPTION_PRESETS.find(item => item.id === presetId) ?? GAME_TIPS_CAPTION_PRESETS[0];
  return [
    `${preset.label}🔥`,
    `365FreeBonus X ${provider}`,
    preset.body,
    "🔥Free Credit Trusted Wallet🔥\nFind Free Bonus Offers\n🌐 EXPLORE BONUS OFFERS:\nhttps://365freebonus.com",
  ].join("\n\n");
}
