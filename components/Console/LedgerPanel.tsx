/**
 * LedgerPanel.tsx
 * The tally: every call-up, bid, sale and pass, newest first.
 *
 * The ruled-paper background is drawn by a repeating gradient at a 22px pitch,
 * so each row has to be exactly 22px tall for the text to sit on the lines.
 * That is why rows are a fixed-height grid rather than free-flowing text.
 */
import { moneyTight } from "../../console/format";
import type { LogEntry } from "../../console/types";

export default function LedgerPanel({
  log,
  onClear,
}: {
  log: LogEntry[];
  /**
   * Omitted on read-only routes, where resetting the auction is not on offer.
   * The control is then not rendered at all rather than wired to a no-op — a
   * button that does nothing is worse than no button.
   */
  onClear?: () => void;
}) {
  return (
    <div className="ledger">
      <div className="lhead">
        <span className="eyebrow">Tally</span>
        {onClear && log.length > 0 && (
          <button type="button" className="linkbtn" onClick={onClear}>
            Reset auction
          </button>
        )}
      </div>

      <div className="lbody">
        {log.length === 0 ? (
          <div className="lempty">
            Every bid, sale and pass gets written down here as it happens.
          </div>
        ) : (
          log.map((entry) => (
            <div key={entry.seq} className={`lrow k-${entry.kind}`}>
              <span className="i">{entry.seq}</span>
              <span className="w">
                {entry.kind === "sold" ? <b>{entry.what}</b> : entry.what}
              </span>
              <span className="a">{entry.amount == null ? "—" : moneyTight(entry.amount)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
