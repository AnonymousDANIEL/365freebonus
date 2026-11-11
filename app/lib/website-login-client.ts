import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { load } from "cheerio";
import ipaddr from "ipaddr.js";

export type WebsiteLoginInput = {
  loginUrl: string; verifyUrl: string; successText: string;
  username: string; password: string; usernameField?: string; passwordField?: string; existingSession?: string;
};
export class WebsiteLoginError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "WebsiteLoginError"; }
}
const unsupported = () => new WebsiteLoginError("此网页的登录方式暂不兼容。当前仅支持标准 HTTPS 网页表单，请手动登录或联系网站提供 API。");
const unsafe = () => new WebsiteLoginError("请使用公开网站的 HTTPS 登录地址，不支持内网、IP 地址、跨站登录或此站点。");
const manual = () => new WebsiteLoginError("网页需要验证码或双重验证，请先在该网站手动完成登录。");
const responseTooLarge = () => new WebsiteLoginError("网页内容超过 4 MB 的安全读取上限，自动登录已暂停，请检查登录或验证地址。");
// Inline scripts and embedded assets can make ordinary login HTML exceed 512 KiB.
// Keep a bounded response while allowing these pages; no asset requests are made.
const MAX_BODY = 4 * 1024 * 1024;
const MAX_POST = 64 * 1024;
const BLOCKED = ["syabas99.com", "bintang44.com"];

export function validateWebsiteUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw unsafe(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash || value.length > 2048
    || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || host.endsWith(".")
    || /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)
    || BLOCKED.some(domain => host === domain || host.endsWith(`.${domain}`))) throw unsafe();
  return url;
}

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
// DNS is validated on every new connection and the validated address is passed
// directly to TLS's lookup callback, so a second lookup cannot rebind to /data's host.
export async function resolvePublicWebsiteHost(hostname: string, resolve: Resolver = host => lookup(host, { all: true, verbatim: true })): Promise<Address[]> {
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some(({ address }) => {
    try { return ipaddr.parse(address).range() !== "unicast"; } catch { return true; }
  })) throw unsafe();
  return addresses;
}

export type WebsiteResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
export type WebsiteTransport = (url: URL, method: "GET" | "POST", body: string | undefined, headers: Record<string, string>, signal: AbortSignal) => Promise<WebsiteResponse>;

async function publicRequest(url: URL, method: "GET" | "POST", body: string | undefined, headers: Record<string, string>, signal: AbortSignal): Promise<WebsiteResponse> {
  signal.throwIfAborted();
  let abortDns: (() => void) | undefined;
  const addresses = await Promise.race([
    resolvePublicWebsiteHost(url.hostname),
    new Promise<never>((_, reject) => {
      abortDns = () => reject(new WebsiteLoginError("登录连接超时，请稍后再试。"));
      signal.addEventListener("abort", abortDns, { once: true });
    }),
  ]).finally(() => { if (abortDns) signal.removeEventListener("abort", abortDns); });
  signal.throwIfAborted();
  const chosen = addresses[0];
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, [chosen]);
    else callback(null, chosen.address, chosen.family);
  };
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method, headers, signal, lookup: pinnedLookup,
      agent: false, rejectUnauthorized: true, minVersion: "TLSv1.2",
    }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (Number(res.headers["content-length"] || 0) > MAX_BODY) {
        res.destroy(); req.destroy(); reject(responseTooLarge()); return;
      }
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          res.destroy(); req.destroy(); reject(responseTooLarge());
        } else chunks.push(chunk);
      });
      res.once("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.once("error", () => reject(new WebsiteLoginError("网站连接中断，请稍后再试。")));
    });
    req.setTimeout(10_000, () => req.destroy());
    req.once("error", () => reject(new WebsiteLoginError(signal.aborted ? "登录连接超时，请稍后再试。" : "无法安全连接该网站，请检查地址和网站状态。")));
    req.end(body);
  });
}

type Cookie = { name: string; value: string; path: string; expires: number };
class CookieJar {
  private cookies: Cookie[] = [];
  restore(value: string | undefined, origin: string, username: string): boolean {
    if (!value || value.length > 32768) return false;
    try {
      const parsed = JSON.parse(value) as { origin?: unknown; username?: unknown; cookies?: unknown };
      if (parsed.origin !== origin || parsed.username !== username || !Array.isArray(parsed.cookies) || parsed.cookies.length > 64) return false;
      const cookies: Cookie[] = [];
      for (const raw of parsed.cookies) {
        if (!raw || typeof raw !== "object") return false;
        const cookie = raw as Cookie;
        if (typeof cookie.name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || typeof cookie.value !== "string" || /[\x00-\x20\x7f;,]/.test(cookie.value)
          || typeof cookie.path !== "string" || !cookie.path.startsWith("/") || typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires)) return false;
        if (cookie.expires > Date.now()) cookies.push(cookie);
      }
      this.cookies = cookies;
      return cookies.length > 0;
    } catch { return false; }
  }
  serialize(origin: string, username: string): string {
    const serialized = JSON.stringify({ origin, username, cookies: this.cookies });
    if (serialized.length > 32768) throw unsupported();
    return serialized;
  }
  accept(url: URL, lines: string[]) {
    for (const line of lines) {
      if (line.length > 4096) continue;
      const [pair, ...attributes] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (index < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue;
      const attrs = new Map(attributes.map(part => {
        const i = part.indexOf("=");
        return [part.slice(0, i < 0 ? undefined : i).trim().toLowerCase(), i < 0 ? "" : part.slice(i + 1).trim()];
      }));
      const domain = attrs.get("domain")?.replace(/^\./, "").toLowerCase();
      if (domain && url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
      const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/";
      const path = attrs.get("path")?.startsWith("/") ? attrs.get("path")! : defaultPath;
      let expires = Number.MAX_SAFE_INTEGER;
      if (attrs.has("expires")) {
        const parsedExpiry = Date.parse(attrs.get("expires")!);
        if (Number.isFinite(parsedExpiry)) expires = parsedExpiry;
      }
      if (attrs.has("max-age") && /^-?\d+$/.test(attrs.get("max-age")!)) expires = Date.now() + Number(attrs.get("max-age")) * 1000;
      this.cookies = this.cookies.filter(cookie => cookie.name !== name || cookie.path !== path);
      if (expires > Date.now() && this.cookies.length < 64) this.cookies.push({ name, value, path, expires });
    }
  }
  header(url: URL): string {
    const value = this.cookies.filter(cookie => cookie.expires > Date.now() && (url.pathname === cookie.path || (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith("/") || url.pathname[cookie.path.length] === "/"))))
      .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
    if (value.length > 8192) throw unsupported();
    return value;
  }
}

function challenge(html: string) {
  const $ = load(html);
  return !!$("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], [data-sitekey], input[autocomplete='one-time-code']").length
    || $("input:not([type='hidden'])").toArray().some(el => /(^|[_-])(captcha|otp|totp|2fa|passcode|verification_code|security_code)($|[_-])/i.test($(el).attr("name") || ""));
}

export function parseWebsiteLoginForm(html: string, pageUrl: URL, input: WebsiteLoginInput): { action: URL; body: string } {
  if (challenge(html)) throw manual();
  const $ = load(html);
  const forms = $("form").toArray().filter(el => {
    const passwords = $(el).find("input[type='password']:not([disabled])").toArray();
    return input.passwordField ? passwords.some(p => $(p).attr("name") === input.passwordField) : passwords.length === 1;
  });
  if (forms.length !== 1) throw unsupported();
  const form = $(forms[0]);
  if ((form.attr("method") || "get").toLowerCase() !== "post" || !["", "application/x-www-form-urlencoded"].includes((form.attr("enctype") || "").toLowerCase())) throw unsupported();
  const fields = form.find("input:not([disabled])").toArray();
  const passwordFields = fields.filter(el => ($(el).attr("type") || "text").toLowerCase() === "password" && (!input.passwordField || $(el).attr("name") === input.passwordField));
  if (passwordFields.length !== 1) throw unsupported();
  const passwordName = $(passwordFields[0]).attr("name");
  let userFields = fields.filter(el => ["text", "email", "tel"].includes(($(el).attr("type") || "text").toLowerCase()) && $(el).attr("name"));
  if (input.usernameField) userFields = userFields.filter(el => $(el).attr("name") === input.usernameField);
  else {
    const named = userFields.filter(el => $(el).attr("autocomplete") === "username" || /user|email|login|account|phone/i.test($(el).attr("name") || ""));
    if (named.length) userFields = named;
  }
  if (!passwordName || userFields.length !== 1) throw unsupported();
  const usernameName = $(userFields[0]).attr("name")!;
  if (usernameName === passwordName || fields.length > 100) throw unsupported();
  const body = new URLSearchParams();
  for (const el of fields) {
    if (($(el).attr("type") || "").toLowerCase() === "hidden" && $(el).attr("name")) body.append($(el).attr("name")!, $(el).attr("value") || "");
  }
  body.set(usernameName, input.username);
  body.set(passwordName, input.password);
  const submit = form.find("button:not([type]), button[type='submit'], input[type='submit']").filter(":not([disabled])").first();
  if (submit.attr("name") && ![usernameName, passwordName].includes(submit.attr("name")!)) body.append(submit.attr("name")!, submit.attr("value") || "");
  let action: URL;
  try { action = validateWebsiteUrl(new URL(submit.attr("formaction") || form.attr("action") || pageUrl.href, pageUrl).href); } catch { throw unsafe(); }
  if (action.origin !== pageUrl.origin || Buffer.byteLength(body.toString()) > MAX_POST) throw unsafe();
  return { action, body: body.toString() };
}

// Injectable transport exists only for isolated server tests. The production
// entry point always uses the pinned public-network TLS client above.
export async function executeWebsiteLogin(input: WebsiteLoginInput, transport: WebsiteTransport): Promise<{ session: string }> {
  const login = validateWebsiteUrl(input.loginUrl);
  const verify = validateWebsiteUrl(input.verifyUrl);
  if (login.origin !== verify.origin || !input.successText.trim() || input.successText.length > 200 || !input.username || input.username.length > 256 || !input.password || input.password.length > 1024) throw unsafe();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const jar = new CookieJar();
  const restored = jar.restore(input.existingSession, login.origin, input.username);
  async function navigate(initial: URL, initialMethod: "GET" | "POST" = "GET", initialBody?: string, activeJar = jar, allowSignedOut = false) {
    let url = initial, method = initialMethod, body = initialBody;
    for (let redirect = 0; redirect <= 5; redirect++) {
      controller.signal.throwIfAborted();
      if (url.origin !== login.origin) throw unsafe();
      const headers: Record<string, string> = { "User-Agent": "365FreeBonus-WebsiteLogin/1.0", Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "identity" };
      const cookie = activeJar.header(url); if (cookie) headers.Cookie = cookie;
      if (method === "POST") Object.assign(headers, { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body || "")), Origin: login.origin, Referer: login.href });
      const response = await transport(url, method, body, headers, controller.signal);
      if (Buffer.byteLength(response.body) > MAX_BODY) throw responseTooLarge();
      const rawCookies = response.headers["set-cookie"];
      activeJar.accept(url, Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : []);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (typeof location !== "string" || redirect === 5) throw unsupported();
        url = validateWebsiteUrl(new URL(location, url).href);
        if (url.origin !== login.origin) throw unsafe();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
        continue;
      }
      if (response.status === 403 || response.status === 429) throw new WebsiteLoginError("网站拒绝自动访问或要求人工验证，请在该网站手动处理。");
      if (challenge(response.body)) throw manual();
      if (allowSignedOut && response.status === 401) return { ...response, url };
      if (response.status < 200 || response.status >= 300) throw new WebsiteLoginError("网站未接受登录请求，请检查账号或网站状态。");
      return { ...response, url };
    }
    throw unsupported();
  }
  function isAuthenticated(html: string): boolean {
    const $ = load(html);
    if ($("input[type='password']").length) return false;
    $("script,style,template,noscript").remove();
    const text = $.root().text().replace(/\s+/g, " ").trim();
    return text.includes(input.successText.replace(/\s+/g, " ").trim());
  }
  try {
    // A public marker is not proof of authentication. Baseline verification uses
    // a separate empty jar and its anonymous cookies never enter the login jar.
    const anonymous = await navigate(verify, "GET", undefined, new CookieJar(), true);
    if (isAuthenticated(anonymous.body)) throw new WebsiteLoginError("识别文字在未登录时也可见，请改用登录后专属的页面和文字。");
    if (restored) {
      const existing = await navigate(verify);
      if (isAuthenticated(existing.body)) return { session: jar.serialize(login.origin, input.username) };
    }
    const page = await navigate(login);
    const form = parseWebsiteLoginForm(page.body, page.url, input);
    await navigate(form.action, "POST", form.body);
    const confirmed = await navigate(verify);
    if (!isAuthenticated(confirmed.body)) throw new WebsiteLoginError("尚未验证登录成功，请检查账号密码、验证地址或登录后才能看到的识别文字。");
    return { session: jar.serialize(login.origin, input.username) };
  } catch (error) {
    if (error instanceof WebsiteLoginError) throw error;
    throw new WebsiteLoginError(controller.signal.aborted ? "登录连接超时，请稍后再试。" : "无法完成网站登录，请检查网站设置或手动处理。");
  } finally { clearTimeout(timer); }
}

export function loginWebsite(input: WebsiteLoginInput): Promise<{ session: string }> {
  return executeWebsiteLogin(input, publicRequest);
}
