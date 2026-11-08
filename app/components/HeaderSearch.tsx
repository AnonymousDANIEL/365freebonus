import './header-search.css';

export default function HeaderSearch() {
  return (
    <a className="header-search" href="/" aria-label="365freebonus.com home">
      <svg className="header-search-wordmark" viewBox="235 423 1578 521" aria-hidden="true" focusable="false">
        <image href="/brand/google-wordmark.png" width="2048" height="1365" />
      </svg>
      <span className="header-search-field" aria-hidden="true">
        <svg className="header-search-art" viewBox="62 141 742 123" focusable="false">
          <image href="/brand/google-search-bar.png" width="850" height="408" />
        </svg>
        <span className="header-search-text-window">
          <span className="header-search-reserved">
            <span className="header-search-typed">365freebonus.com</span>
          </span>
        </span>
      </span>
    </a>
  );
}
