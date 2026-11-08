import { Search } from 'lucide-react';
import './header-search.css';

export default function HeaderSearch() {
  return (
    <a className="header-search" href="/" aria-label="365freebonus.com home">
      <span className="header-search-label" aria-hidden="true">Google Search</span>
      <span className="header-search-field" aria-hidden="true">
        <Search className="header-search-icon" size={15} />
        <span className="header-search-reserved">
          <span className="header-search-typed">365freebonus.com</span>
        </span>
      </span>
    </a>
  );
}
