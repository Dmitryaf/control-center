const headingDate = new Intl.DateTimeFormat('ru', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function NotebookHeading({
  title,
  date,
  subtitle,
}: {
  title: string;
  date?: Date;
  subtitle?: string;
}) {
  return (
    <header className="notebook-heading">
      <div>
        {date && <p className="notebook-date">{headingDate.format(date)}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      <svg className="notebook-sketch" viewBox="0 0 120 84" fill="none" aria-hidden="true">
        <g transform="rotate(9 63 39)" stroke="#8398ae" strokeWidth="1.7">
          <rect x="35" y="14" width="48" height="56" rx="4" fill="#e5eaf0" />
        </g>
        <g
          transform="rotate(-9 53 41)"
          stroke="#536d8b"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="28" y="10" width="49" height="58" rx="4" fill="#faf7ef" />
          <path d="M36 11v55m8-41h21M44 32h18m-17 8h13" />
          <path d="m55 53 22-17 4 5-23 17-6 2z" fill="#b4c9d9" />
          <path d="m74 39 4 4" />
        </g>
        <path d="m87 23 4-4m-2 11 6-1" stroke="#bb876b" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </header>
  );
}
