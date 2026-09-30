/**
 * Yo-Harness logo: blue rabbit character with transparent background.
 */

export function Logo({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg
      className={`logo-svg ${className}`}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="logo-grad" x1="256" y1="100" x2="256" y2="460" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7DD3FC" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <path
        d="M155,185
           C140,130 115,100 95,115
           C75,130 90,170 120,190
           L120,215
           C120,290 145,340 195,355
           C170,365 120,385 110,415
           C100,445 130,470 165,460
           C200,450 225,420 230,380
           L230,340
           C275,340 310,310 320,260
           L335,190
           C365,170 380,130 360,115
           C340,100 315,130 300,185
           Z"
        fill="url(#logo-grad)"
      />
      <circle cx="210" cy="235" r="18" fill="#0f172a" />
      <circle cx="275" cy="235" r="18" fill="#0f172a" />
      <path
        d="M222,265 Q242,288 262,265"
        stroke="#0f172a"
        strokeWidth="7"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
