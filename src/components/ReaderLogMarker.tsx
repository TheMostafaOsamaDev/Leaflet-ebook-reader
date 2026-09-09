import { useEffect, useState } from "react";
import { eventCount, flushNow, log, snapshotReader } from "../lib/devLog";

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Dev-only. Lets the reader stamp "what I am looking at right now is wrong"
 * into the log, and confirms on screen that it landed.
 *
 * A blank reading pane cannot be detected from script — every measurement
 * reads correct while the screen shows nothing — so the one piece of
 * information no instrumentation can supply is the reader's own eyes. Pressing
 * ⌘⇧L writes a marked snapshot and flushes the file immediately, so the log
 * says exactly which moment to look at.
 *
 * The banner matters as much as the key: without visible confirmation, a press
 * that worked is indistinguishable from one the OS swallowed, which already
 * cost a round of this investigation.
 */
export function ReaderLogMarker({ scrollRef }: Props) {
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    // Matches on `code`: on macOS, holding Option rewrites the character, and
    // Control+Option is VoiceOver's own modifier.
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyL" || !e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      log("MARK", { note: "reader says the pane looks wrong right now" });
      snapshotReader(scrollRef.current, "MARK");
      void flushNow().then(() => {
        setBanner(`LOGGED · ${eventCount()} events written`);
        window.setTimeout(() => setBanner(null), 1800);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrollRef]);

  if (!banner) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        top: 90,
        transform: "translateX(-50%)",
        zIndex: 10001,
        padding: "10px 18px",
        borderRadius: 10,
        background: "rgba(0,0,0,0.86)",
        color: "#a8e6a1",
        font: '13px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: "none",
      }}
    >
      {banner}
    </div>
  );
}
