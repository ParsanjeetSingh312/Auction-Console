/**
 * Hammer.tsx
 * The auction gavel, as drawings: a standalone mark, and the strike scene the
 * SOLD cinematic animates.
 *
 * SVG rather than an image so it scales to any size, inherits nothing it should
 * not, and costs no second request.
 *
 * **The geometry is what makes the strike read.** The gavel is drawn upright --
 * handle vertical, head across the top and centred on it -- and every pose is a
 * rotation of that one drawing about the grip (`GRIP`). Drawn already tilted,
 * or with the head off the handle's line, every rotation compounds the error:
 * the earlier artwork joined the handle near one end of the head, so the
 * wind-up read as an "L" rather than a raised gavel.
 *
 * In the scene, `STRIKE_ANGLE` is the rotation at which the lower end face of
 * the head lands on the top of the sound block. The block, the impact point and
 * the grip are all expressed in the same viewBox, so the cinematic can key its
 * shockwave and sparks to the exact point of contact.
 */

/** Where the hand holds the handle, in scene coordinates. The rotation pivot. */
export const GRIP = { x: 150, y: 122 };
/** Rotation (deg) at which the head's end face meets the block. */
export const STRIKE_ANGLE = -75;
/** The point of contact on the block's top face, in scene coordinates. */
export const IMPACT = { x: 61, y: 138 };
/** The scene's viewBox size. */
export const SCENE = { width: 200, height: 160 };

function Defs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-head`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#f7e2ae" />
        <stop offset="50%" stopColor="#d8b271" />
        <stop offset="100%" stopColor="#8d6a35" />
      </linearGradient>
      <linearGradient id={`${id}-shaft`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#e9d3a4" />
        <stop offset="100%" stopColor="#7d5c2e" />
      </linearGradient>
      <linearGradient id={`${id}-block`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#6b4a26" />
        <stop offset="100%" stopColor="#3a2612" />
      </linearGradient>
    </defs>
  );
}

/**
 * The gavel upright: handle from y=48 down to y=126, head centred on x=150.
 * Rotated about GRIP, this is every pose the strike needs.
 */
function GavelShape({ id }: { id: string }) {
  return (
    <>
      <rect x="145" y="48" width="10" height="78" rx="5" fill={`url(#${id}-shaft)`} />
      {/* A darker collar where the handle enters the head. */}
      <rect x="143" y="50" width="14" height="6" rx="2" fill="#8d6a35" />
      {/* Head, with a raised cheek at each striking end. */}
      <rect x="115" y="28" width="70" height="24" rx="6" fill={`url(#${id}-head)`} />
      <rect x="111" y="25" width="12" height="30" rx="4" fill={`url(#${id}-head)`} />
      <rect x="177" y="25" width="12" height="30" rx="4" fill={`url(#${id}-head)`} />
      <rect x="146" y="28" width="8" height="24" rx="3" fill="#fff6dd" opacity="0.45" />
    </>
  );
}

/** The mark on its own, tilted like a gavel at rest. */
export function Hammer({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="70 0 160 160" width="100%" height="100%" role="presentation" focusable="false">
      <Defs id="auctiq-hammer" />
      <g transform={`rotate(-35 ${GRIP.x} ${GRIP.y - 40})`}>
        <GavelShape id="auctiq-hammer" />
      </g>
    </svg>
  );
}

/**
 * The strike scene: a sound block, the gavel, and the spark burst at the point
 * of contact. Class names are the cinematic's handles:
 *
 *   .hd__gavel   rotated about GRIP (use GSAP `svgOrigin`)
 *   .hd__block   squashed on impact
 *   .hd__sparks  burst out of IMPACT
 *
 * `restAngle` poses the gavel statically, for reduced motion.
 */
export function GavelScene({ restAngle }: { restAngle?: number }) {
  const id = "auctiq-gavel-scene";
  const sparks = [-150, -118, -90, -62, -30];
  return (
    <svg
      viewBox={`0 0 ${SCENE.width} ${SCENE.height}`}
      width="100%"
      height="100%"
      role="presentation"
      focusable="false"
      style={{ overflow: "visible" }}
    >
      <Defs id={id} />

      {/* The sound block: a turned wooden disc, seen slightly from above. */}
      <g className="hd__block">
        <ellipse cx="60" cy="152" rx="38" ry="8" fill="#2a1a0b" />
        <rect x="22" y="140" width="76" height="12" fill={`url(#${id}-block)`} />
        <ellipse cx="60" cy="140" rx="38" ry="9" fill="#8a6234" />
        <ellipse cx="60" cy="139" rx="30" ry="6" fill="#a87a45" opacity="0.6" />
      </g>

      {/* Sparks, radiating up and out from the point of contact. */}
      <g className="hd__sparks" opacity="0">
        {sparks.map((deg) => {
          const rad = (deg * Math.PI) / 180;
          const x1 = IMPACT.x + Math.cos(rad) * 14;
          const y1 = IMPACT.y + Math.sin(rad) * 14;
          const x2 = IMPACT.x + Math.cos(rad) * 30;
          const y2 = IMPACT.y + Math.sin(rad) * 30;
          return (
            <line
              key={deg}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#9be7ff"
              strokeWidth="3"
              strokeLinecap="round"
            />
          );
        })}
      </g>

      <g
        className="hd__gavel"
        transform={restAngle === undefined ? undefined : `rotate(${restAngle} ${GRIP.x} ${GRIP.y})`}
      >
        <GavelShape id={id} />
      </g>
    </svg>
  );
}
