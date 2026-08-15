# press — the nightly paper

A printable PDF about your own product, built every night and scheduled to land
in your inbox at wake-up.

Not a changelog. The goal is that reading it leaves you understanding your
product better than you did yesterday — the thing that quietly erodes when
agents write most of the code.

## Status

**Working.** Charts, collector, renderer, print stylesheet, and the loop
instructions all exist, and `press/example/edition.json` renders to a six-page
PDF today. What it has not yet done is run unattended against a real repo for a
week, which is the only test that matters.

Unlike `rounds`, this half is not blocked on the Telnyx bug — it is the cheaper
thing to finish first.

## Parts

| Path | What it is |
| --- | --- |
| `../loop/SKILL.md` | The nightly loop. Claude Code follows this; it is the product. |
| `bin/collect.mjs` | Deterministic facts from `git` and `gh`. Makes no judgements. |
| `bin/render.mjs` | `edition.json` → HTML → PDF via headless Chrome. |
| `lib/charts.mjs` | Dependency-free SVG charts, built for paper. |
| `templates/edition.css` | Print stylesheet. A4, no dark mode, no breakpoints. |
| `example/edition.json` | Schema contract and render fixture. Read this first. |

## Try it

```bash
# facts from any repo
node press/bin/collect.mjs --repo /path/to/repo --days 7 > facts.json

# render the reference edition
node press/bin/render.mjs press/example/edition.json --out /tmp/edition.pdf --keep-html

# schedule tonight's edition for 06:30 tomorrow
screenless mail /tmp/edition.pdf --at 06:30
```

`--keep-html` prints the intermediate HTML path, which is much faster to iterate
on than regenerating the PDF.

## The split that makes it work

Scripts produce facts; the model produces judgement. Keeping these apart is the
whole design:

- A model re-deriving line counts burns tokens and gets them wrong.
- A script deciding what is *interesting* produces a paper nobody reads.

So `collect.mjs` will never rank, and `../loop/SKILL.md` will never count.

## Design constraints

Everything here follows from the output being paper:

- **Grayscale-safe.** Series separate by lightness, never hue alone, because the
  page may come out of a mono laser.
- **No hairlines under 0.5pt, no type under 8pt.** Thinner drops out on toner.
- **One subject per sheet.** You flip pages rather than scroll, so a page that
  spills is a page that failed.
- **Captions, not paragraphs.** Anything needing more than ~40 words belongs on
  the call, where you can interrupt it.
- **The spot colour appears once per page.** Used twice, it marks nothing.

## Known gaps

- **Never run unattended for a full week.** The loop is written but unproven.
- **Screenshots need a dev server up.** It skips them silently when the server
  is down, which is right for reliability but means editions vary in richness.
- **Areas are inferred from path depth.** Two segments works for most repos and
  will be wrong for some; there is no override yet.
- **No layout feedback.** The renderer cannot tell the author a page overflowed,
  so page-count discipline is currently a human check.

## The loop lives elsewhere

This folder is the toolkit: fact collection, the chart library, the print
stylesheet and the renderer. The nightly run that uses it — and that also
builds the morning call from the same reading — is [`../loop/SKILL.md`](../loop/SKILL.md).
