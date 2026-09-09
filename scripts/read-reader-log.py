#!/usr/bin/env python3
"""Decode the reader's debug log into something a person can follow.

The reader writes JSON-per-line to
  ~/Library/Application Support/com.leaflet.reader/debug/reader-debug.log
(see src/lib/devLog.ts). Each geometry event carries the full ancestor chain,
which is the point of the log but far too much to read raw.

Usage:
  scripts/read-reader-log.py               # timeline
  scripts/read-reader-log.py --marks       # only what the reader marked, in full
  scripts/read-reader-log.py --full <t>    # one event's complete payload
"""
import json
import os
import sys

DEFAULT = os.path.expanduser(
    "~/Library/Application Support/com.leaflet.reader/debug/reader-debug.log"
)

# Anything here can make an element fail to appear. A blank page is normally
# one of them, and they are indistinguishable on screen.
SUSPECT = {
    "display": "none",
    "visibility": "hidden",
    "opacity": "0",
}


def suspicious(node):
    """Reasons this ancestor could be hiding what is inside it."""
    out = []
    for k, bad in SUSPECT.items():
        if node.get(k) == bad:
            out.append(f"{k}={bad}")
    if node.get("opacity") not in (None, "1") and node.get("opacity") != "0":
        out.append(f"opacity={node['opacity']}")
    if node.get("transform") not in (None, "none"):
        out.append(f"transform={node['transform']}")
    if node.get("clipPath") not in (None, "none"):
        out.append(f"clipPath={node['clipPath']}")
    if node.get("filter") not in (None, "none"):
        out.append(f"filter={node['filter']}")
    if node.get("contain") not in (None, "none"):
        out.append(f"contain={node['contain']}")
    if not node.get("onScreen", True):
        r = node.get("rect", {})
        out.append(f"OFF-SCREEN rect={r}")
    return out


def geometry_line(d):
    sc, pa = d.get("scroll", {}), d.get("paras", {})
    head = d.get("heading") or {}
    hit = d.get("hitTest") or {}
    bits = [
        f'{d.get("tag",""):14}',
        f'scroll={sc.get("top")}/{sc.get("max")}',
        f'paras={pa.get("count")}',
        f'onScreen={pa.get("onScreen")}',
        f'heading={"on" if head.get("onScreen") else "off"}',
        f'hit={hit.get("el","-")}',
    ]
    w = d.get("wrapper") or {}
    if w:
        bits.append(f'wrapper[op={w.get("opacity")} tr={w.get("transform")}]')
    line = "  ".join(bits)
    flags = []
    for node in d.get("chain", []):
        s = suspicious(node)
        if s:
            flags.append(f'{node["el"]}: {", ".join(s)}')
    if flags:
        line += "\n" + "\n".join(f"                 ! {f}" for f in flags)
    return line


def main():
    args = sys.argv[1:]
    path = DEFAULT
    for a in args:
        if not a.startswith("--") and os.path.exists(a):
            path = a
    if not os.path.exists(path):
        print(f"no log at {path}\nOpen a book in the dev build first.")
        return 1

    events = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"[unparsed] {line[:100]}")

    if "--full" in args:
        want = int(args[args.index("--full") + 1])
        for e in events:
            if e["t"] == want:
                print(json.dumps(e, indent=2, ensure_ascii=False))
        return 0

    marks_only = "--marks" in args
    if marks_only:
        idx = [i for i, e in enumerate(events) if e["kind"] == "MARK"]
        if not idx:
            print("No MARK events — press ⌘⇧B/⌘⇧L in the reader while the pane looks wrong.")
            return 0
        for i in idx:
            print(f"=== MARK at t={events[i]['t']}ms ===")
            # The geometry taken with the mark, plus a little either side.
            for e in events[i : i + 2]:
                if e["kind"] == "geometry":
                    print(json.dumps(e["data"], indent=2, ensure_ascii=False))
        return 0

    print(f"{path}\n{len(events)} events\n")
    for e in events:
        t, k, d = e["t"], e["kind"], e.get("data")
        if k == "geometry":
            print(f"[{t:7}] geometry {geometry_line(d)}")
        elif k == "MARK":
            print(f"[{t:7}] *** MARK — reader says the pane is wrong here ***")
        elif k == "session":
            b = (d or {}).get("book", {})
            print(f"[{t:7}] session  {b.get('id')} · {b.get('chapters')} chapters · "
                  f"win {d['window']['w']}x{d['window']['h']}@{d['window']['dpr']} · "
                  f"mode={d.get('readingMode')} focus={d.get('focusMode')}")
        else:
            print(f"[{t:7}] {k:22} {json.dumps(d, ensure_ascii=False)[:150]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
