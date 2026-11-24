export const GAME_TIPS_UPLOAD_LIMIT = 4 * 1024 * 1024;
export const GAME_TIPS_PROVIDER_LIMIT = 48;
export const GAME_TIPS_NAME_LIMIT = 65;

export function gameTipsProviderKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export type GameTipsAsset = {
  id: string;
  provider: string;
  game: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type GameTipsProvider = { name: string; count: number; logoId?: string };
export type GameTipsLibrary = { assets: GameTipsAsset[]; providers: GameTipsProvider[] };
export type GameTipsSelection = { provider: string; logoId?: string; games: Array<{ id: string; game: string }> };

export function gameTipsCaption(selection: { provider: string; games: Array<{ game: string }> }): string {
  return [
    "Game Tips🔥",
    `365FreeBonus X ${selection.provider}`,
    selection.games.map(item => item.game).join("\n"),
    "🔥Free Credit Trusted Wallet🔥\nFind Free Bonus Offers\n🌐 EXPLORE BONUS OFFERS:\nhttps://365freebonus.com",
  ].join("\n\n");
}
