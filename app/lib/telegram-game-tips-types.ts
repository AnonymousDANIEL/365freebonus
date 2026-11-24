export const GAME_TIPS_UPLOAD_LIMIT = 4 * 1024 * 1024;
export const GAME_TIPS_PROVIDER_LIMIT = 48;
export const GAME_TIPS_NAME_LIMIT = 65;

export type GameTipsBackgroundSlot = { x: number; y: number; width: number; height: number };

export const GAME_TIPS_DEFAULT_SLOTS: readonly GameTipsBackgroundSlot[] = [
  { x: 4.85, y: 59.27, width: 26.67, height: 29.33 },
  { x: 36.89, y: 59.27, width: 25.98, height: 29.33 },
  { x: 68.47, y: 59.27, width: 26.54, height: 29.33 },
];

export function validGameTipsBackgroundSlots(input: unknown): input is GameTipsBackgroundSlot[] {
  if (!Array.isArray(input) || input.length !== 3) return false;
  for (const slot of input) {
    if (!slot || typeof slot !== "object" || Object.keys(slot).length !== 4) return false;
    const { x, y, width, height } = slot;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
      width < 5 || height < 5 || x + width > 100 || y + height > 100) return false;
  }
  return !input.some((a, index) => input.slice(index + 1).some(b =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
}

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

export type GameTipsProvider = { name: string; count: number; logoId?: string; backgroundId?: string; backgroundSlots?: GameTipsBackgroundSlot[] };
export type GameTipsLibrary = { assets: GameTipsAsset[]; providers: GameTipsProvider[] };
export type GameTipsSelection = { provider: string; logoId?: string; backgroundId?: string; games: Array<{ id: string; game: string }> };
