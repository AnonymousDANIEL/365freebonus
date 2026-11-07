export type BrandCategory = "All" | "Update" | "New";
export const DEFAULT_PROMOTION_DAYS = 7;
export const PROMOTION_DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeBrandCategory(category: unknown): BrandCategory {
  return category === "Update" || category === "New" ? category : "All";
}

export type Brand = {
  id: string;
  name: string;
  slug: string;
  category: BrandCategory;
  promotionDays: number | null;
  promotionExpiresAt: number | null;
  tagline: string;
  description: string;
  color: string;
  icon: string;
  imageUrl: string;
  featured: boolean;
  published: boolean;
  sortOrder: number;
  link: string;
};

export function effectiveBrandCategory(brand: Pick<Brand, "category" | "promotionExpiresAt">, now = Date.now()): BrandCategory {
  const category = normalizeBrandCategory(brand.category);
  return category !== "All" && typeof brand.promotionExpiresAt === "number" && Number.isFinite(brand.promotionExpiresAt) && brand.promotionExpiresAt > now ? category : "All";
}

export type SiteSettings = {
  name: string;
  eyebrow: string;
  headline: string;
  description: string;
  announcement: string;
  contactUrl: string;
  coverImageUrl: string;
  avatarImageUrl: string;
};

export type DirectoryData = { settings: SiteSettings; brands: Brand[] };

export const defaultSettings: SiteSettings = {
  name: "365freebonus",
  eyebrow: "A LITTLE CURIOSITY GOES A LONG WAY",
  headline: "Discover more.\nFind your favourite.",
  description: "Thoughtfully chosen brands and fresh ideas, all in one elegant space. Take a look around — your next favourite could be here.",
  announcement: "Welcome to 365freebonus · A space for discovery.",
  contactUrl: "",
  coverImageUrl: "",
  avatarImageUrl: "",
};

// Fictional demonstration content. These entries make no real-world claims.
export const seedBrands: Brand[] = [
  { id: "nova", name: "NOVA PLAY", slug: "nova-play", category: "All", promotionDays: null, promotionExpiresAt: null, tagline: "Play beyond the ordinary.", description: "An imagined world of creative play, new adventures and friendly competition. NOVA PLAY is a fictional brand created to demonstrate this directory.", color: "#d4b779", icon: "sparkles", imageUrl: "", featured: true, published: true, sortOrder: 1, link: "" },
  { id: "orbit", name: "ORBIT", slug: "orbit", category: "All", promotionDays: null, promotionExpiresAt: null, tagline: "Find your own orbit.", description: "A fictional destination for music, culture and unexpected discoveries. Explore the concept, then replace this example with your own brand in the dashboard.", color: "#a594bb", icon: "orbit", imageUrl: "", featured: true, published: true, sortOrder: 2, link: "" },
  { id: "lumi", name: "LUMI", slug: "lumi", category: "All", promotionDays: null, promotionExpiresAt: null, tagline: "A little brighter, every day.", description: "An illustrative lifestyle brand celebrating thoughtful everyday experiences. This entry is editable demonstration content.", color: "#be9f75", icon: "sun", imageUrl: "", featured: true, published: true, sortOrder: 3, link: "" },
  { id: "pixelverse", name: "PIXELVERSE", slug: "pixelverse", category: "All", promotionDays: null, promotionExpiresAt: null, tagline: "Small pixels. Endless worlds.", description: "An imaginary universe for people who enjoy independent games and creative worlds. A fictional example for this brand directory.", color: "#8392ad", icon: "gamepad", imageUrl: "", featured: false, published: true, sortOrder: 4, link: "" },
  { id: "afterhours", name: "AFTERHOURS", slug: "afterhours", category: "All", promotionDays: null, promotionExpiresAt: null, tagline: "Make room for the unexpected.", description: "A fictional entertainment concept inspired by live music, cinema and city culture. Use the management dashboard to change this content.", color: "#b98caa", icon: "moon", imageUrl: "", featured: false, published: true, sortOrder: 5, link: "" },
  { id: "vanta", name: "VANTA", slug: "vanta", category: "All", promotionDays: null, promotionExpiresAt: null, tagline: "Less noise. More you.", description: "An imagined design and lifestyle collection with a quieter point of view. This is sample content, not an endorsement of a real service.", color: "#b5bcc8", icon: "triangle", imageUrl: "", featured: false, published: true, sortOrder: 6, link: "" },
];
