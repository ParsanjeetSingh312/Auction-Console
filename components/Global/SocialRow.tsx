/**
 * SocialRow.tsx
 * The social glyphs, defined once and used by both the header and the footer.
 *
 * The reference draws three icons in the header and four in the footer, with
 * only two of them in common. That is a generated inconsistency rather than a
 * decision, and two hand-maintained lists of the same links is how a set of
 * icons ends up pointing at three different accounts. One list, both rows.
 *
 * **Every URL is null, and that is a decision rather than unfinished work.**
 * Pointing these at invented handles would be a fabrication, and pointing them
 * at "#" gives the page controls that look clickable and do nothing. So a null
 * renders the glyph as decoration — `aria-hidden`, not focusable, out of the tab
 * order — and the moment a real URL is filled in, that same entry becomes a
 * properly labelled external link. Supply the handles and both rows turn on with
 * no other change anywhere.
 */
export interface Social {
  name: string;
  /** Null renders the glyph as decoration rather than as a link. */
  url: string | null;
  path: string;
}

export const SOCIALS: Social[] = [
  {
    name: "Instagram",
    url: null,
    path: "M12 2.2c3.2 0 3.6 0 4.9.07 1.2.05 1.8.25 2.2.42.6.22 1 .48 1.4.9.42.4.68.8.9 1.4.17.4.37 1 .42 2.2.06 1.3.07 1.7.07 4.9s0 3.6-.07 4.9c-.05 1.2-.25 1.8-.42 2.2a3.8 3.8 0 0 1-.9 1.4c-.4.42-.8.68-1.4.9-.4.17-1 .37-2.2.42-1.3.06-1.7.07-4.9.07s-3.6 0-4.9-.07c-1.2-.05-1.8-.25-2.2-.42a3.8 3.8 0 0 1-1.4-.9 3.8 3.8 0 0 1-.9-1.4c-.17-.4-.37-1-.42-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.07-4.9c.05-1.2.25-1.8.42-2.2.22-.6.48-1 .9-1.4.4-.42.8-.68 1.4-.9.4-.17 1-.37 2.2-.42C8.4 2.2 8.8 2.2 12 2.2Zm0 3.2a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2Zm0 2.3a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6Zm6.9-2.6a1.55 1.55 0 1 1-3.1 0 1.55 1.55 0 0 1 3.1 0Z",
  },
  {
    name: "Facebook",
    url: null,
    path: "M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.5-3.89 3.77-3.89 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99A10 10 0 0 0 22 12Z",
  },
  {
    name: "X",
    url: null,
    path: "M17.53 3h3.05l-6.66 7.61L21.75 21h-6.13l-4.8-6.28L5.32 21H2.27l7.12-8.14L2.25 3h6.29l4.34 5.74L17.53 3Zm-1.07 16.17h1.69L7.62 4.74H5.8l10.66 14.43Z",
  },
  {
    name: "YouTube",
    url: null,
    path: "M21.58 7.19a2.51 2.51 0 0 0-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42a2.51 2.51 0 0 0-1.77 1.77A26.1 26.1 0 0 0 2 12a26.1 26.1 0 0 0 .42 4.81 2.51 2.51 0 0 0 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42a2.51 2.51 0 0 0 1.77-1.77A26.1 26.1 0 0 0 22 12a26.1 26.1 0 0 0-.42-4.81ZM10 15.02V8.98L15.2 12 10 15.02Z",
  },
];

/**
 * One glyph — a link when it has somewhere to go, decoration when it does not.
 */
export function SocialGlyph({ name, url, path }: Social) {
  const icon = (
    <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="currentColor" aria-hidden>
      <path d={path} />
    </svg>
  );

  if (!url) {
    return (
      <span className="grid h-9 w-9 place-items-center text-auctiq-dim/45" aria-hidden>
        {icon}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`AUCTIQ on ${name}`}
      className="grid h-9 w-9 place-items-center text-auctiq-dim transition-colors duration-200 hover:text-auctiq-text"
    >
      {icon}
    </a>
  );
}

/**
 * The row.
 *
 * `limit` exists because the header has less width to spend than the footer and
 * the reference shows a shorter row there — a slice of one list rather than a
 * second list.
 */
export default function SocialRow({
  limit,
  className = "",
}: {
  limit?: number;
  className?: string;
}) {
  const shown = limit ? SOCIALS.slice(0, limit) : SOCIALS;

  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      {shown.map((social) => (
        <SocialGlyph key={social.name} {...social} />
      ))}
    </div>
  );
}
