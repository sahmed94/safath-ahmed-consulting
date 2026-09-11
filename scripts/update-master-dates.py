#!/usr/bin/env python3
"""Refresh the "Updated" dates on master/index.html and re-sort the cards.

Each card's date comes from the last commit touching the page it links to, so
the directory can't drift out of sync with reality. Cards are then sorted
newest-first *within* their own section — "Consulting Instances" and "Other
Projects" are distinct groupings, so they're never merged into one list.

    scripts/update-master-dates.py           # rewrite the file in place
    scripts/update-master-dates.py --check   # exit 1 if stale, change nothing

--check is what you want in a pre-commit hook or CI.

Cards are discovered by parsing the file, and each card's target is resolved
from its own "View Page" href, so a newly added card is picked up with no
change to this script. A card with no Updated line gets one inserted.

Two things this deliberately does not do. A card belongs to whichever grid it
physically sits in, so cards are never moved between sections -- that grouping
is editorial, not derived. And the sort is stable, so cards whose pages were
last touched by the same commit keep whatever order they already have; a true
tie has no correct answer, and reshuffling one on every run would be churn.
"""

import argparse
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

# A card block: an opening <div class="pcard"...> through the </div> that sits
# at the same indentation. Cards don't nest, so this stays unambiguous.
CARD_RE = re.compile(
    r'^(?P<indent>[ \t]*)<div class="pcard".*?\n(?P=indent)</div>\n',
    re.S | re.M,
)
GRID_RE = re.compile(r'<div class="card-grid">')
CTA_RE = re.compile(r'^(?P<indent>[ \t]*)<a class="cta" href="(?P<href>[^"]+)"', re.M)
TIME_RE = re.compile(r'<time datetime="[^"]*">[^<]*</time>')
UPDATED_META_RE = re.compile(r'^[ \t]*<div class="meta"><b>Updated:</b>.*?</div>\n', re.M)


def repo_root() -> Path:
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, check=True)
    return Path(out.stdout.strip())


def last_commit_iso(root: Path, target: Path) -> str | None:
    """Author date of the last commit touching `target`, as strict ISO.

    For a page in its own directory we ask about the whole directory, so that
    replacing an image counts as updating the page. For a page sitting at the
    repo root we can only ask about the file itself -- the root directory would
    match every commit in the repo.
    """
    rel = target.relative_to(root)
    scope = rel if rel.parent == Path(".") else rel.parent
    cmd = ["git", "log", "-1", "--format=%aI"]
    if scope == rel:
        cmd.append("--follow")  # --follow needs a single file path
    cmd += ["--", str(scope)]
    out = subprocess.run(cmd, capture_output=True, text=True, cwd=root)
    return out.stdout.strip() or None


def human(iso: str) -> str:
    d = dt.date.fromisoformat(iso[:10])
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}"


def grid_index(pos: int, grid_starts: list[int]) -> int:
    """Which card-grid does a card at `pos` belong to?"""
    return sum(1 for g in grid_starts if g < pos) - 1


def apply_date(card: str, iso: str) -> str:
    """Set the card's Updated line, inserting one if absent."""
    tag = f'<time datetime="{iso[:10]}">{human(iso)}</time>'
    if TIME_RE.search(card):
        return TIME_RE.sub(tag, card, count=1)
    cta = CTA_RE.search(card)
    indent = cta.group("indent")
    return card[:cta.start()] + f'{indent}<div class="meta"><b>Updated:</b> {tag}</div>\n' + card[cta.start():]


def rebuild(src: str, page: Path, root: Path) -> tuple[str, list[str]]:
    grid_starts = [m.start() for m in GRID_RE.finditer(src)]
    cards = list(CARD_RE.finditer(src))
    if not cards:
        raise SystemExit(f"no .pcard blocks found in {page} -- has the markup changed?")

    notes: list[str] = []
    entries = []  # (grid, sort key, rewritten text, original index)
    for i, m in enumerate(cards):
        text = m.group(0)
        cta = CTA_RE.search(text)
        if not cta:
            raise SystemExit(f"card {i} in {page} has no 'View Page' link; cannot resolve its date")
        target = (page.parent / cta.group("href")).resolve()
        iso = last_commit_iso(root, target) if target.is_file() else None
        if iso is None:
            notes.append(f"  ! {cta.group('href')}: no committed history; leaving its date alone")
            existing = TIME_RE.search(text)
            iso = existing.group(0).split('"')[1] if existing else ""
        else:
            text = apply_date(text, iso)
        entries.append((grid_index(m.start(), grid_starts), iso, text, i))

    # Stable sort => cards whose dates are genuinely identical keep their order.
    order = sorted(range(len(entries)), key=lambda k: (entries[k][0], _neg(entries[k][1])))

    out, prev = [], 0
    for slot, m in enumerate(cards):
        out.append(src[prev:m.start()])
        out.append(entries[order[slot]][2])
        prev = m.end()
    out.append(src[prev:])
    return "".join(out), notes


def _neg(iso: str):
    """Sort key that puts the newest first; blanks sort last."""
    return (iso == "", [-ord(c) for c in iso])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if the file is out of date; write nothing")
    ap.add_argument("--file", default="master/index.html",
                    help="page to update (default: master/index.html)")
    args = ap.parse_args()

    root = repo_root()
    page = (root / args.file).resolve()
    if not page.is_file():
        raise SystemExit(f"{args.file} not found under {root}")

    src = page.read_text(encoding="utf-8")
    new, notes = rebuild(src, page, root)
    for n in notes:
        print(n, file=sys.stderr)

    if new == src:
        print(f"{args.file}: up to date")
        return 1 if notes else 0

    if args.check:
        print(f"{args.file}: STALE -- run scripts/update-master-dates.py", file=sys.stderr)
        return 1

    page.write_text(new, encoding="utf-8")
    print(f"{args.file}: updated")
    return 1 if notes else 0


if __name__ == "__main__":
    sys.exit(main())
