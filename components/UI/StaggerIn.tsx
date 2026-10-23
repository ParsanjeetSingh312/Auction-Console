/**
 * StaggerIn.tsx
 * Its children rise into place one after another when it mounts (GSAP), so a
 * tab full of panels arrives as a sequence rather than all at once. Nothing
 * happens under reduced motion; nothing replays on re-render.
 */
import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

export default function StaggerIn({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        if (!root.current) return;
        gsap.from(root.current.children, {
          y: 14,
          autoAlpha: 0,
          duration: 0.45,
          ease: "power3.out",
          stagger: 0.08,
          clearProps: "transform,opacity,visibility",
        });
      });
    },
    { scope: root },
  );
  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}
