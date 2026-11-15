import { createHash, timingSafeEqual } from "node:crypto";

export const ORIGIN_VERIFY_HEADER = "x-365-origin-verify";

// The value is read at request time so it stays server-only and can be rotated
// independently of a build. A configured but malformed value fails closed.
export function originGuardEnabled(): boolean {
  return Boolean(process.env.ORIGIN_VERIFY_SECRET);
}

function validToken(value: string): boolean {
  // Headers merges duplicate values with a comma. Neither commas nor whitespace
  // are valid proof tokens, so a duplicated or malformed proof is rejected.
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

export function hasVerifiedOrigin(request: Pick<Request, "headers">): boolean {
  const expected = process.env.ORIGIN_VERIFY_SECRET;
  const supplied = request.headers.get(ORIGIN_VERIFY_HEADER);
  if (!expected || !supplied || !validToken(expected) || !validToken(supplied)) return false;

  // Equal-sized digests keep the secret comparison constant-time even when a
  // visitor provides a token of a different length.
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
