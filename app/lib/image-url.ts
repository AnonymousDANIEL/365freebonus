export function isSafeImageUrl(value: string): boolean {
  if (!value) return true;
  if (value.length > 2048 || /[\s\\"'<>\x00-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith("/")) {
    const pathname = value.split(/[?#]/, 1)[0];
    if (pathname.includes("//") || /%(?:2f|5c|00)/i.test(pathname)) return false;
    try {
      const decoded = decodeURIComponent(pathname);
      if (decoded.split("/").some(part => part === "." || part === "..")) return false;
      return new URL(value, "https://local.invalid").origin === "https://local.invalid";
    } catch { return false; }
  }
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
