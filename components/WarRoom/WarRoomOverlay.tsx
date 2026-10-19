/**
 * WarRoomOverlay.tsx
 * The auction, full-bleed, over the landing.
 *
 * **It writes no simulation of its own.** `AuctionBlock` already is one — its
 * header says so plainly: *"with no `socket` prop it runs its own mock auction,
 * so the layout and every animation can be exercised with no backend at all."*
 * It has been live at `/auction/demo` since Phase 3. Building a second engine
 * here would mean two mock auctions that drift apart, and a demo that stops
 * matching the thing it is demonstrating.
 *
 * So this file is only the container: a portal, a focus trap, and a way out.
 * That also means the step-7 effects come for free — the hammer, the coins and
 * the alarm are mounted inside `BlockView`, which is what `AuctionBlock`
 * renders, so the demo exercises them without knowing they exist.
 *
 * **On the focus trap.** A modal that leaves focus behind it is a keyboard user
 * tabbing invisibly through the landing while an auction covers the screen.
 * Focus moves in on open, is held inside while open, and returns to whatever
 * opened it on close — the last of which is the part most often forgotten and
 * the most disorienting to lose.
 *
 * Rendered through a portal to `document.body` rather than in place, because
 * the landing's hero sits inside stacking contexts (`transform`, `filter`,
 * `backdrop-filter`) and a fixed child of a transformed ancestor positions
 * against that ancestor, not the viewport. In place, this would be full-bleed
 * inside a card.
 */
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { getLenis } from "../../hooks/useJourney";
import AuctionBlock from "../Auction/AuctionBlock";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface WarRoomOverlayProps {
  open: boolean;
  onClose: () => void;
  /** The franchise the demo bids for. */
  myTeam?: string;
  /** Opening purse, ₹ lakh. */
  purse?: number;
}

export default function WarRoomOverlay({
  open,
  onClose,
  myTeam = "MUM",
  purse = 12000,
}: WarRoomOverlayProps) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const reduced = useReducedMotion() ?? false;

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;

    returnTo.current = document.activeElement as HTMLElement | null;

    // The landing keeps scrolling underneath otherwise, and the journey's
    // camera would fly about behind a modal nobody can see it through.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Smooth scroll would otherwise keep moving the landing under the modal.
    const lenis = getLenis();
    lenis?.stop();

    // The red-ball pointer stays on in here: it is drawn above every overlay
    // (see CricketCursor), so the war room keeps the site's cursor.

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const root = panel.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        // Nothing focusable yet — keep focus on the panel rather than letting
        // it escape to the page behind.
        event.preventDefault();
        root.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    // After paint, so the panel exists to receive it.
    const id = window.setTimeout(() => panel.current?.focus(), 0);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(id);
      document.body.style.overflow = previousOverflow;
      lenis?.start();
      returnTo.current?.focus?.();
    };
  }, [open, close]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[80] bg-black"
          initial={reduced ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
          role="dialog"
          aria-modal="true"
          aria-label="War room demo"
        >
          <div ref={panel} tabIndex={-1} className="h-full w-full outline-none">
            <AuctionBlock
              myTeam={myTeam}
              purse={purse}
              corner={
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md border border-neutral-700 bg-neutral-900/80 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-300 transition hover:border-neutral-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                >
                  close demo
                </button>
              }
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
