/**
 * MarksPanel.tsx
 * The auctioneer's marking scheme, applied to the room as it stands.
 *
 * One row per franchise: its overall mark and a bar for each factor of the
 * scheme set in Auction Setup, in the auctioneer's priority order. These are
 * the same marks each franchise's auction report prints (auction/marking.py),
 * read from the room on demand, so the panel and the PDFs cannot disagree.
 *
 * Auctioneer's screen only. It shows every franchise side by side, and a
 * franchise is not shown its rivals' marks: each one's own are in its report.
 *
 * Refetched whenever a lot settles (the sold and unsold counts are the
 * dependency), never on a timer: the marks only move when a sale does.
 */
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ClipboardCheck } from "lucide-react";

import { apiUrl } from "../../../console/apiBase";
import { withRoom } from "../../../console/auctionRoom";
import type { AuctionSocket } from "../../../hooks/useAuctionSocket";

gsap.registerPlugin(useGSAP);

interface Mark {
  key: string;
  label: string;
  weight: number;
  value: number;
  detail: string;
}

interface Row {
  team: { id: number; name: string; code: string; color: string };
  squad_size: number;
  overall: number;
  verdict: string;
  marks: Mark[];
}

interface Marks {
  custom_scheme: boolean;
  scheme: { key: string; label: string }[];
  franchises: Row[];
}

const tone = (value: number) => (value >= 7 ? "#34D399" : value >= 5 ? "#F6C45A" : "#F87171");

export default function MarksPanel({ socket }: { socket: AuctionSocket }) {
  const root = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Marks | null>(null);
  const [failed, setFailed] = useState(false);
  const counts = socket.state?.counts;
  const scheme = (socket.state?.rules.marking_scheme ?? []).join(",");
  const settled = (counts?.sold ?? 0) + (counts?.unsold ?? 0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl(withRoom("/api/v1/auction/report/marks")), { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: Marks) => {
        setData(body);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [settled, scheme]);

  useGSAP(
    () => {
      if (!data) return;
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".mark-bar", {
          scaleX: 0,
          transformOrigin: "left center",
          duration: 0.5,
          ease: "power2.out",
          stagger: 0.012,
        });
      });
    },
    { scope: root, dependencies: [data] },
  );

  const columns = data?.franchises[0]?.marks ?? [];

  return (
    <div ref={root} data-testid="marks-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="flex items-center gap-1.5 font-head text-[13px] font-bold uppercase tracking-[0.1em] text-slate-ink">
          <ClipboardCheck size={14} /> Marking scheme
        </h3>
        <span className="font-ui text-[10.5px] uppercase tracking-[0.1em] text-slate-faint">
          {data
            ? data.custom_scheme
              ? "your scheme, in priority order"
              : "AUCTONIQ's standard rating · set your own in Setup"
            : failed
              ? "could not load the marks"
              : "marking…"}
        </span>
      </div>

      {data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-faint">
                <th className="px-4 py-2 text-left font-semibold">Franchise</th>
                <th className="px-2 py-2 text-right font-semibold">Overall</th>
                {columns.map((mark, index) => (
                  <th key={mark.key} className="px-2 py-2 text-left font-semibold">
                    {data.custom_scheme ? `${index + 1}. ` : ""}
                    {mark.label}
                    <span className="ml-1 opacity-60">{Math.round(mark.weight * 100)}%</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.franchises.map((row) => (
                <tr key={row.team.id} className="border-t border-line">
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-4 w-[3px] rounded-sm" style={{ backgroundColor: row.team.color }} />
                      <span className="font-head text-[12.5px] font-bold text-slate-ink">{row.team.name}</span>
                      <span className="font-ui text-[10px] text-slate-faint">{row.squad_size} bought</span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span
                      className="font-num text-[17px] font-bold"
                      style={{ color: row.squad_size ? tone(row.overall) : undefined }}
                    >
                      {row.squad_size ? row.overall.toFixed(1) : "–"}
                    </span>
                  </td>
                  {row.marks.map((mark) => (
                    <td key={mark.key} className="px-2 py-2" title={mark.detail}>
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-full max-w-[90px] overflow-hidden rounded-full bg-white/10">
                          <span
                            className="mark-bar block h-full rounded-full"
                            style={{
                              width: `${row.squad_size ? mark.value * 10 : 0}%`,
                              backgroundColor: tone(mark.value),
                            }}
                          />
                        </span>
                        <span className="font-num text-[12.5px] font-semibold text-slate-body">
                          {row.squad_size ? mark.value.toFixed(1) : "–"}
                        </span>
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-line px-4 py-2 font-ui text-[10.5px] leading-snug text-slate-faint">
        Marks out of 10, updated as each lot settles. Hover a mark for the arithmetic behind it. Each franchise's
        auction report prints its own marks; only this screen shows them side by side.
      </p>
    </div>
  );
}
