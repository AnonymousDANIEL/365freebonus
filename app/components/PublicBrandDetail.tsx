import type { Brand, SiteSettings } from "../lib/directory";
import { isSafeSocialUrl } from "../lib/directory";
import { isSafeImageUrl } from "../lib/image-url";
import { defaultAvatarImageUrl } from "../lib/brand-media";
import "./public-brand-detail.css";

type Props = { brand: Brand; settings: SiteSettings };

/** The listing is rendered as text from the public CMS record, without invented offer claims. */
export default function PublicBrandDetail({ brand, settings }: Props) {
  const image = brand.imageUrl && isSafeImageUrl(brand.imageUrl) ? brand.imageUrl : "";
  const avatar = settings.avatarImageUrl && isSafeImageUrl(settings.avatarImageUrl)
    ? settings.avatarImageUrl : defaultAvatarImageUrl;
  const provider = isSafeSocialUrl(brand.link) ? brand.link : "";
  const providerHost = provider ? new URL(provider).hostname : "";
  const providerIsTelegram = /^(?:www\.)?(?:t\.me|telegram\.me)$/i.test(providerHost);
  const telegram = settings.telegramEnabled && isSafeSocialUrl(settings.telegramUrl) ? settings.telegramUrl : "";

  return <div className="public-site public-brand-detail">
    <header className="brand-detail-header">
      <a href="/" className="brand-detail-identity" aria-label="365 Free Bonus home">
        <img src={avatar} width={42} height={42} alt="" />
        <span>365 Free Bonus</span>
      </a>
      <a className="brand-detail-back" href="/#collection">Browse all brands <span aria-hidden="true">↗</span></a>
    </header>

    <main className="brand-detail-main">
      <nav className="brand-detail-breadcrumb" aria-label="Breadcrumb">
        <ol><li><a href="/">Home</a></li><li><span aria-hidden="true">/</span></li><li aria-current="page">{brand.name}</li></ol>
      </nav>

      <article className="brand-detail-article">
        <section className="brand-detail-hero" aria-labelledby="brand-detail-title">
          <div className="brand-detail-art">
            {image ? <img src={image} width={640} height={640} alt={brand.name} fetchPriority="high" />
              : <span className="brand-detail-monogram" aria-hidden="true">{brand.name.slice(0, 2).toLocaleUpperCase()}</span>}
          </div>
          <div className="brand-detail-intro">
            <div className="brand-detail-kicker">BRAND DIRECTORY{brand.category !== "All" && <span>{brand.category}</span>}</div>
            <h1 id="brand-detail-title">{brand.name}</h1>
            {brand.tagline.trim() && <p className="brand-detail-tagline">{brand.tagline}</p>}
            <p className="brand-detail-purpose">Read the information provided for this brand and review the provider’s current conditions before deciding to join.</p>
            {provider && <a className="brand-detail-provider" href={provider} target="_blank" rel="noopener noreferrer">
              {providerIsTelegram ? "Open brand Telegram" : "Visit brand website"} <span aria-hidden="true">↗</span>
            </a>}
          </div>
        </section>

        <div className="brand-detail-content-grid">
          <section className="brand-detail-copy" aria-labelledby="brand-detail-information">
            <h2 id="brand-detail-information">Brand information</h2>
            <div className="brand-detail-description">{brand.description}</div>
          </section>

          <aside className="brand-detail-guidance" aria-labelledby="brand-detail-conditions">
            <h2 id="brand-detail-conditions">Before you continue</h2>
            <p>Offer availability, eligibility and usage conditions depend on the provider. Check its current terms and any limits before participating.</p>
            {provider ? <div className="brand-detail-source">
              <span>{providerIsTelegram ? "Brand Telegram" : "Provider website"}</span>
              <a href={provider} target="_blank" rel="noopener noreferrer">{providerHost} <span aria-hidden="true">↗</span></a>
            </div> : <p className="brand-detail-source-note">A provider website has not been added to this listing.</p>}
            <p className="brand-detail-source-note">This page displays the details supplied for this listing. It does not confirm that every offer mentioned is currently available.</p>
          </aside>
        </div>
      </article>
    </main>

    <footer className="brand-detail-footer">
      <strong>365 Free Bonus</strong>
      <div className="brand-detail-footer-links"><a href="/#collection">Explore brands</a>{telegram && <a href={telegram} target="_blank" rel="noopener noreferrer">Join Telegram <span aria-hidden="true">↗</span></a>}</div>
    </footer>
  </div>;
}
