/**
 * Inline tabler-style line icons for the admin kit (T9.2).
 *
 * The public site uses astro-icon, which can't render inside React islands, so
 * the kit ships its own tiny hand-rolled SVG set — stroke `currentColor`, 24
 * viewBox, round caps/joins — matching the tabler visual language without a
 * dependency. `aria-hidden` by default; give a `title` for a labeled icon.
 */
import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  title?: string;
}

function IconBase({ size = 20, title, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M5 12l5 5L20 7" />
  </IconBase>
);
export const IconX = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </IconBase>
);
export const IconChevronDown = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M6 9l6 6 6-6" />
  </IconBase>
);
export const IconChevronLeft = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M15 6l-6 6 6 6" />
  </IconBase>
);
export const IconChevronRight = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M9 6l6 6-6 6" />
  </IconBase>
);
export const IconChevronUp = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M6 15l6-6 6 6" />
  </IconBase>
);
export const IconSelector = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
  </IconBase>
);
export const IconSearch = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </IconBase>
);
export const IconPlus = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 5v14M5 12h14" />
  </IconBase>
);
export const IconTrash = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </IconBase>
);
export const IconLock = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </IconBase>
);
export const IconPencil = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </IconBase>
);
export const IconExternalLink = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M14 4h6v6M20 4l-8 8" />
    <path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
  </IconBase>
);
export const IconAlertTriangle = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" />
  </IconBase>
);
export const IconInfo = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </IconBase>
);
/** D4 "Error" glyph (T1.1) — a circle-!, deliberately distinct from `IconInfo`'s
 * circle-i (stroke above the dot here, not below) and from `IconAlertTriangle`. */
export const IconAlertCircle = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 17h.01" />
  </IconBase>
);
/** D4 "Blocked" glyph (T1.1) — an octagon with a hard stop mark inside, distinct
 * from the bare cross `IconX` and reserved for the true dead-end level. */
export const IconOctagon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
    <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
  </IconBase>
);
export const IconDots = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 6h.01M12 12h.01M12 18h.01" />
  </IconBase>
);
export const IconClock = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4l3 2" />
  </IconBase>
);
export const IconHome = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 11l8-7 8 7" />
    <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
    <path d="M10 20v-6h4v6" />
  </IconBase>
);
export const IconLibrary = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="4" width="7" height="7" rx="1" />
    <rect x="4" y="13" width="7" height="7" rx="1" />
    <rect x="13" y="13" width="7" height="7" rx="1" />
  </IconBase>
);
export const IconSparkles = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />
    <path d="M18 15l.7 1.8L20.5 17.5 18.7 18.2 18 20l-.7-1.8L15.5 17.5l1.8-.7z" />
  </IconBase>
);
export const IconPalette = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 3a9 9 0 0 0 0 18 2 2 0 0 0 2-2 2 2 0 0 1 2-2h1a4 4 0 0 0 4-4 9 9 0 0 0-9-8z" />
    <circle cx="7.5" cy="10.5" r="1" />
    <circle cx="10.5" cy="7" r="1" />
    <circle cx="15" cy="8" r="1" />
  </IconBase>
);
export const IconSettings = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L16 3H8l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L8 21h8l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z" />
  </IconBase>
);
export const IconUser = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </IconBase>
);
export const IconWrench = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M14 7a4 4 0 0 0-5.5 4.5l-4 4a2.1 2.1 0 0 0 3 3l4-4A4 4 0 0 0 16 9l-2 2-2-2 2-2z" />
  </IconBase>
);
export const IconMenu = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </IconBase>
);
export const IconLogout = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </IconBase>
);
export const IconRocket = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2a2.8 2.8 0 0 0-3-3z" />
    <path d="M9 13l-2-2c1-4 4-7 10-8 -1 6-4 9-8 10z" />
    <circle cx="14.5" cy="9.5" r="1.2" />
  </IconBase>
);
export const IconFilePlus = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" />
    <path d="M14 3v4h4M12 11v6M9 14h6" />
  </IconBase>
);
export const IconRobot = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="4" y="8" width="16" height="11" rx="2" />
    <path d="M12 4v4M9 13v.01M15 13v.01M9 16h6" />
  </IconBase>
);
export const IconSend = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4.5 12L20 5l-3 14-5.5-4.5z" />
    <path d="M11.5 14.5L20 5" />
  </IconBase>
);
export const IconMic = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3M9 21h6" />
  </IconBase>
);
export const IconLayoutList = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="4" y="5" width="16" height="4" rx="1" />
    <rect x="4" y="11" width="16" height="4" rx="1" />
    <rect x="4" y="17" width="16" height="2.5" rx="1" />
  </IconBase>
);
export const IconLayoutGrid = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="4" width="7" height="7" rx="1" />
    <rect x="4" y="13" width="7" height="7" rx="1" />
    <rect x="13" y="13" width="7" height="7" rx="1" />
  </IconBase>
);
export const IconArchive = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
    <path d="M10 13h4" />
  </IconBase>
);
export const IconTag = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12.5 4H6a2 2 0 0 0-2 2v6.5a1 1 0 0 0 .3.7l9 9a1 1 0 0 0 1.4 0l6.5-6.5a1 1 0 0 0 0-1.4l-9-9a1 1 0 0 0-.7-.3z" />
    <circle cx="8.5" cy="8.5" r="1.25" />
  </IconBase>
);
export const IconChartBar = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M4 20h16" />
  </IconBase>
);
export const IconMail = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3.5 6.5l8 6.2a1 1 0 0 0 1 0l8-6.2" />
  </IconBase>
);
