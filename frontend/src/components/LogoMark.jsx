export default function LogoMark({ className = '' }) {
  return <svg className={`logo-symbol ${className}`} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <circle className="logo-lens" cx="29" cy="28" r="21" stroke="currentColor" strokeWidth="4"/>
    <path className="logo-stem" d="m45 44 12 12" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/>
    <path className="logo-leaf" d="M19 37c-5-17 7-22 24-22 0 17-6 28-24 22Z" fill="currentColor"/>
    <path d="m20 38 16-16" stroke="var(--logo-vein, #192922)" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>
}
