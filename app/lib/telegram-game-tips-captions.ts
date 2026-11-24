export const GAME_TIPS_CAPTION_PRESETS = [
  { id: "news-update", label: "News Update Game Tips", body: "See this edition’s featured games and browse the latest listings." },
  { id: "featured-selection", label: "Featured Game Picks", body: "Take a look at the featured lineup and explore more games from this platform." },
  { id: "bonus-roundup", label: "Game Tips & Bonus Roundup", body: "Browse this edition’s game picks and check the latest offers and their terms." },
] as const;

export const DEFAULT_GAME_TIPS_CAPTION_PRESET_ID = GAME_TIPS_CAPTION_PRESETS[0].id;

export const GAME_TIPS_CAPTION_BODIES = [
  { id: "today", title: "🔥 TODAY’S GAME TIPS!", copy: "Discover featured games and useful tips before you play!" },
  { id: "play-smarter", title: "🎯 PLAY SMARTER, NOT HARDER!", copy: "Know your game, understand the features and make smarter choices!" },
  { id: "fresh-tips", title: "🚀 FRESH GAME TIPS JUST FOR YOU!", copy: "Looking for something different? Check out today’s game selection!" },
  { id: "next-favourite", title: "💎 DISCOVER YOUR NEXT FAVOURITE!", copy: "Explore exciting games and learn what makes them special!" },
  { id: "dont-miss", title: "🔥 DON’T MISS TODAY’S GAME TIPS!", copy: "Check out our featured games and discover something new!" },
  { id: "ready-to-explore", title: "👑 HEY BOSS, READY TO EXPLORE?", copy: "We’ve picked some exciting games for you to check out today!" },
  { id: "smart-play", title: "⚡ SMART PLAY STARTS HERE!", copy: "Understand the game, know your limits and enjoy every moment!" },
  { id: "daily-guide", title: "🎮 YOUR DAILY GAME GUIDE IS HERE!", copy: "Explore popular games, discover their features and find your favourite!" },
  { id: "fresh-picks", title: "💥 NEW DAY, FRESH GAME PICKS!", copy: "Not sure which game to explore? Check out our latest recommendations!" },
  { id: "stay-updated", title: "🏆 STAY UPDATED, PLAY SMART!", copy: "Follow our Game Tips for fresh recommendations and useful game information!" },
] as const;

export function isGameTipsCaptionPresetId(value: unknown): value is (typeof GAME_TIPS_CAPTION_PRESETS)[number]["id"] {
  return GAME_TIPS_CAPTION_PRESETS.some(item => item.id === value);
}

export function gameTipsCaption(provider: string, presetId?: string | null, body?: { title: string; copy: string }): string {
  const preset = GAME_TIPS_CAPTION_PRESETS.find(item => item.id === presetId) ?? GAME_TIPS_CAPTION_PRESETS[0];
  return [
    `${preset.label}🔥`,
    `365FreeBonus X ${provider}`,
    body ? `${body.title}\n${body.copy}` : preset.body,
    "🔥Free Credit Trusted Wallet🔥\nFind Free Bonus Offers\n🌐 EXPLORE BONUS OFFERS:\nhttps://365freebonus.com",
  ].join("\n\n");
}
