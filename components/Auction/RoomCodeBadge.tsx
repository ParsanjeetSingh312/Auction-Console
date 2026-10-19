/**
 * RoomCodeBadge.tsx
 * The room's code, on the auctioneer's control panel, to send to the
 * franchise owners.
 *
 * The one place on the site the code is shown (console/auctionRoom.ts): it is
 * rendered only inside the auctioneer's screens, never to a franchise or a
 * spectator. Nothing in the main room, which has no code.
 *
 * Beside it, for an account that sends passes, "Send passes": the Send
 * passes dialog with the code already in the note, so the auctioneer can
 * hand their players a seat and the room in one step.
 */
import { useState } from "react";

import { currentRoom } from "../../console/auctionRoom";
import { openSendPasses, useEcosystem } from "../../console/ecosystemStore";

export default function RoomCodeBadge() {
  const { code } = currentRoom();
  const { capabilities } = useEcosystem();
  const [copied, setCopied] = useState(false);
  if (!code) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked; the code is on screen to read out instead.
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-sunken py-1 pl-2.5 pr-1">
      <span className="font-ui text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-faint">
        Room code
      </span>
      <span className="font-num text-[14px] font-bold tracking-[0.16em] text-slate-ink">{code}</span>
      <button
        type="button"
        onClick={copy}
        title="Copy the room code to send to the franchise owners"
        className="rounded-md border border-line bg-surface-card px-2 py-1 font-ui text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {capabilities?.send.includes("D") && (
        <button
          type="button"
          onClick={() => openSendPasses({ note: `Room code ${code}` })}
          title="Send Delegate passes, with this room's code, to your players"
          className="rounded-md px-2 py-1 font-ui text-[9.5px] font-bold uppercase tracking-[0.1em] text-[#020617] transition-opacity hover:opacity-90"
          style={{ background: "linear-gradient(180deg,#cfe2ff,#4d8df6)" }}
        >
          Send passes
        </button>
      )}
    </div>
  );
}
