export const defaultCoverImageUrl = '/brand/gift-transparent.webp';
export const defaultGiftOpeningPlateUrl = '/brand/gift-transparent-base.webp';
export const legacyDefaultCoverImageUrl = '/brand/gift-cover-loop.webp';
export const defaultAvatarImageUrl = '/brand/gift-avatar.webp';

const builtInGiftCovers = new Set([
  defaultCoverImageUrl,
  legacyDefaultCoverImageUrl,
  '/brand/gift-cover-base.webp',
  '/brand/gift-cover.webp',
  '/brand/cover.webp',
  '/brand/cover.png',
]);

/** Upgrade built-in artwork without replacing a cover uploaded by the owner. */
export function isDefaultGiftCover(value?: string | null): boolean {
  const url = value?.trim();
  return !url || builtInGiftCovers.has(url.split(/[?#]/, 1)[0]);
}
