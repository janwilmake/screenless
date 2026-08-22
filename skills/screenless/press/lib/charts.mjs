/**
 * Print-first SVG charts. No dependencies, no runtime — every function returns
 * a self-contained SVG string that survives being embedded in a PDF.
 *
 * Two constraints drive every choice here, and both come from paper:
 *
 * 1. **Grayscale-safe.** A page may be printed on a mono laser. Series are
 *    separated by *lightness*, never by hue alone, and the one spot colour is
 *    mid-dark so it stays distinct from every ink tint when desaturated.
 * 2. **No hairlines below 0.5pt and no type below 8pt.** Thinner strokes drop
 *    out on toner printers; smaller type is unreadable at arm's length.
 *
 * Coordinates are abstract units; the stylesheet scales the SVG to the column.
 */

/* ------------------------------------------------------------------ palette */

export const INK = "#14110f";
export const SPOT = "#b4341f";
export const RULE = "#c9c2bb";
export const PAPER = "#ffffff";

/** Ink tints, ordered light→dark. Distinguishable after desaturation. */
export const TINTS = ["#ddd7d1", "#b9b0a8", "#8d837a", "#5c534b", "#2b2521"];

const tint = (i) => TINTS[i % TINTS.length];

/**
 * Text colour must follow the *fill*, not the series index. Getting this
 * backwards yields near-black labels on near-black cells, which reads as a
 * blank box on paper.
 */
const onDark = (tintIndex) => tintIndex >= 3;

/* ------------------------------------------------------------------ helpers */

export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const round = (n) => Math.round(n * 100) / 100;

/** Compact numbers: 1200 -> 1.2k. Keeps labels short enough to fit in-bar. */
export const fmt = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000) return `${round(v / 1_000_000)}M`;
  if (Math.abs(v) >= 1_000) return `${round(v / 1_000)}k`;
  return String(Math.round(v));
};

const svg = (w, h, body, cls = "") =>
  `<svg class="chart ${cls}" viewBox="0 0 ${w} ${h}" width="100%" ` +
  `preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

const text = (x, y, s, { size = 11, fill = INK, anchor = "start", weight = 400, mono = false } = {}) =>
  `<text x="${round(x)}" y="${round(y)}" font-size="${size}" fill="${fill}" ` +
  `text-anchor="${anchor}" font-weight="${weight}" ` +
  `font-family="${mono ? "ui-monospace, Menlo, monospace" : "inherit"}">${esc(s)}</text>`;

/* --------------------------------------------------------------- bar chart */

/**
 * Horizontal bars. The workhorse: ranked lists where the gap between #1 and #5
 * is the message. Labels sit outside the bar so long names never clip.
 *
 * @param {{label:string, value:number, spot?:boolean, note?:string}[]} items
 */
export function barChart({ items, width = 620, rowHeight = 26, labelWidth = 190, format = fmt }) {
  const rows = items.filter((d) => Number.isFinite(d.value));
  if (!rows.length) return empty(width, 80, "no data");

  const max = Math.max(...rows.map((d) => d.value), 1);
  const h = rows.length * rowHeight + 8;
  const barX = labelWidth + 10;
  // The right gutter holds the value and, under it, the note. Sized so the
  // longest realistic note fits without running off the page — a clipped
  // annotation is worse than no annotation.
  const gutter = 104;
  const barMax = width - barX - gutter;

  const body = rows
    .map((d, i) => {
      const y = i * rowHeight + 4;
      const w = Math.max((d.value / max) * barMax, d.value > 0 ? 1.5 : 0);
      const fill = d.spot ? SPOT : tint(3);
      const textX = barX + w + 6;
      // Whatever room is left after the bar, in characters at 8px.
      const noteRoom = Math.floor((width - textX) / 4.3);
      return (
        `<rect x="${barX}" y="${y}" width="${round(w)}" height="${rowHeight - 10}" fill="${fill}"/>` +
        text(labelWidth, y + rowHeight - 14, d.label, { anchor: "end", size: 11 }) +
        text(textX, y + rowHeight - 14, format(d.value), { size: 10, fill: tint(3) }) +
        (d.note
          ? text(textX, y + rowHeight - 4, truncate(d.note, noteRoom), { size: 8, fill: tint(2) })
          : "")
      );
    })
    .join("");

  return svg(width, h, body, "chart--bar");
}

/* ----------------------------------------------------------------- treemap */

/**
 * Squarified treemap — the "what is my product made of" picture. Area is the
 * only encoding that reads instantly at a glance, which is the whole point of
 * a page you look at rather than read.
 *
 * @param {{label:string, value:number, spot?:boolean}[]} items
 */
export function treemap({ items, width = 620, height = 320 }) {
  const clean = items.filter((d) => Number(d.value) > 0);
  if (!clean.length) return empty(width, height, "no data");

  const cells = squarify(clean, 0, 0, width, height);

  const body = cells
    .map((c, i) => {
      const ti = 4 - (i % 4);
      const fill = c.spot ? SPOT : tint(ti);
      // Only label cells with room for 8pt type plus padding.
      const room = c.w > 54 && c.h > 24;
      const light = c.spot || onDark(ti);
      const label = room
        ? text(c.x + 6, c.y + 15, truncate(c.label, Math.floor(c.w / 6)), {
            size: 10,
            weight: 600,
            fill: light ? PAPER : INK,
          }) +
          (c.h > 38
            ? text(c.x + 6, c.y + 28, fmt(c.value), { size: 9, fill: light ? "#eee" : tint(3) })
            : "")
        : "";
      return (
        `<rect x="${round(c.x)}" y="${round(c.y)}" width="${round(c.w)}" height="${round(c.h)}" ` +
        `fill="${fill}" stroke="${PAPER}" stroke-width="1.5"/>${label}`
      );
    })
    .join("");

  return svg(width, height, body, "chart--treemap");
}

/** Classic squarified layout (Bruls, Huizing & van Wijk). */
function squarify(items, x, y, w, h) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, d) => s + d.value, 0);
  const scale = (w * h) / total;
  let rest = sorted.map((d) => ({ ...d, area: d.value * scale }));
  let [rx, ry, rw, rh] = [x, y, w, h];
  const out = [];

  while (rest.length) {
    const side = Math.min(rw, rh);
    const row = [rest[0]];
    let i = 1;
    // Grow the row while it improves the worst aspect ratio.
    while (i < rest.length && worst(row, side) >= worst([...row, rest[i]], side)) {
      row.push(rest[i]);
      i += 1;
    }
    const rowArea = row.reduce((s, d) => s + d.area, 0);

    if (rw >= rh) {
      const colW = rowArea / rh;
      let cy = ry;
      for (const d of row) {
        const cellH = d.area / colW;
        out.push({ ...d, x: rx, y: cy, w: colW, h: cellH });
        cy += cellH;
      }
      rx += colW;
      rw -= colW;
    } else {
      const rowH = rowArea / rw;
      let cx = rx;
      for (const d of row) {
        const cellW = d.area / rowH;
        out.push({ ...d, x: cx, y: ry, w: cellW, h: rowH });
        cx += cellW;
      }
      ry += rowH;
      rh -= rowH;
    }
    rest = rest.slice(row.length);
  }
  return out;
}

function worst(row, side) {
  const areas = row.map((d) => d.area);
  const sum = areas.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Infinity;
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/* -------------------------------------------------------------- status bar */

/**
 * One stacked horizontal bar — ticket flow at a glance. Segments are labelled
 * in place when they are wide enough, and in a legend when they are not.
 *
 * @param {{label:string, value:number, spot?:boolean}[]} segments
 */
export function statusBar({ segments, width = 620, height = 64 }) {
  const clean = segments.filter((d) => Number(d.value) > 0);
  if (!clean.length) return empty(width, height, "no tickets");

  const total = clean.reduce((s, d) => s + d.value, 0);
  const barH = 30;
  let x = 0;

  const bars = clean
    .map((d, i) => {
      const w = (d.value / total) * width;
      const ti = 4 - (i % 4);
      const fill = d.spot ? SPOT : tint(ti);
      const light = d.spot || onDark(ti);
      const label =
        w > 46
          ? text(x + w / 2, barH / 2 + 4, `${d.value}`, {
              size: 11,
              weight: 600,
              anchor: "middle",
              fill: light ? PAPER : INK,
            })
          : "";
      const cap =
        w > 46
          ? text(x + w / 2, barH + 16, truncate(d.label, Math.floor(w / 6)), {
              size: 9,
              anchor: "middle",
              fill: tint(3),
            })
          : "";
      const seg =
        `<rect x="${round(x)}" y="0" width="${round(w)}" height="${barH}" fill="${fill}" ` +
        `stroke="${PAPER}" stroke-width="1"/>${label}${cap}`;
      x += w;
      return seg;
    })
    .join("");

  return svg(width, height, bars, "chart--status");
}

/* --------------------------------------------------------------- sparkline */

/** Tiny trend line for a stat tile. No axes — shape only. */
export function sparkline({ values, width = 120, height = 28, spot = false }) {
  const vals = values.map(Number).filter(Number.isFinite);
  if (vals.length < 2) return empty(width, height, "");

  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min || 1;
  const step = width / (vals.length - 1);
  const pt = (v, i) => `${round(i * step)},${round(height - 2 - ((v - min) / span) * (height - 4))}`;
  const d = vals.map(pt).join(" ");
  const last = vals[vals.length - 1];

  return svg(
    width,
    height,
    `<polyline points="${d}" fill="none" stroke="${spot ? SPOT : tint(3)}" stroke-width="1.5" ` +
      `stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${round((vals.length - 1) * step)}" cy="${round(
        height - 2 - ((last - min) / span) * (height - 4),
      )}" r="2.2" fill="${spot ? SPOT : INK}"/>`,
    "chart--spark",
  );
}

/* ---------------------------------------------------------------- age plot */

/**
 * Dot plot of open PR age. Reads as "how much is stuck" without a single
 * number being consciously parsed — drift to the right is the signal.
 *
 * @param {{label:string, days:number, spot?:boolean}[]} items
 */
export function agePlot({ items, width = 620, rowHeight = 20, labelWidth = 190, threshold = 7 }) {
  const rows = items.filter((d) => Number.isFinite(d.days));
  if (!rows.length) return empty(width, 80, "no open PRs");

  const max = Math.max(...rows.map((d) => d.days), threshold, 1);
  const plotX = labelWidth + 10;
  const plotW = width - plotX - 40;
  const h = rows.length * rowHeight + 26;

  const gridDays = niceTicks(max);
  const scale = (d) => plotX + (d / max) * plotW;

  const grid = gridDays
    .map(
      (d) =>
        `<line x1="${round(scale(d))}" y1="0" x2="${round(scale(d))}" y2="${rows.length * rowHeight}" ` +
        `stroke="${RULE}" stroke-width="0.5"/>` +
        text(scale(d), rows.length * rowHeight + 14, `${d}d`, {
          size: 8,
          anchor: "middle",
          fill: tint(2),
        }),
    )
    .join("");

  const dots = rows
    .map((d, i) => {
      const y = i * rowHeight + rowHeight / 2;
      const stale = d.days >= threshold;
      return (
        `<line x1="${plotX}" y1="${round(y)}" x2="${round(scale(d.days))}" y2="${round(y)}" ` +
        `stroke="${RULE}" stroke-width="0.5"/>` +
        `<circle cx="${round(scale(d.days))}" cy="${round(y)}" r="4" ` +
        `fill="${stale || d.spot ? SPOT : tint(3)}"/>` +
        text(labelWidth, y + 3.5, d.label, { anchor: "end", size: 10 })
      );
    })
    .join("");

  return svg(width, h, grid + dots, "chart--age");
}

/* ----------------------------------------------------------------- helpers */

function niceTicks(max) {
  const step = max <= 7 ? 1 : max <= 21 ? 7 : max <= 60 ? 14 : 30;
  const out = [];
  for (let d = step; d <= max; d += step) out.push(d);
  return out;
}

function truncate(s, n) {
  const str = String(s ?? "");
  if (n < 3) return "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function empty(w, h, label) {
  return svg(w, h, label ? text(w / 2, h / 2, label, { anchor: "middle", size: 10, fill: tint(2) }) : "", "chart--empty");
}

/* ------------------------------------------------------------------ schema */

/**
 * Entity boxes with their fields, and the relations between them.
 *
 * This exists because "lines changed per area" is a chart about the diff, not
 * about the product — it tells you a PR touched `prisma` without telling you
 * what it did to the data. A reader who sees the shape of the tables learns
 * something they keep; a reader who sees a churn bar learns something that is
 * stale tomorrow.
 *
 * Laid out in columns rather than routed like a real ERD: crossing edges are
 * unreadable in print at this size, so relations are drawn as short labelled
 * connectors between adjacent columns and anything more tangled belongs in two
 * figures rather than one.
 *
 * @param {{name:string, fields?:{name:string,type?:string,note?:string,spot?:boolean}[],
 *          column?:number, spot?:boolean}[]} entities
 * @param {{from:string, to:string, label?:string}[]} relations
 */
export function schema({ entities, relations = [], width = 620 }) {
  const boxes = (entities ?? []).filter((e) => e && e.name);
  if (!boxes.length) return empty(width, 80, "no entities");

  // Column assignment: explicit if given, otherwise fill left-to-right.
  const columns = Math.max(1, Math.min(3, Math.max(...boxes.map((e) => (e.column ?? 0) + 1), 1)));
  const colWidth = (width - (columns - 1) * 34) / columns;
  const rowH = 15;
  const headH = 24;

  const placed = [];
  const nextY = new Array(columns).fill(0);
  boxes.forEach((e, i) => {
    const col = Math.min(e.column ?? i % columns, columns - 1);
    const fields = e.fields ?? [];
    const h = headH + fields.length * rowH + 8;
    const x = col * (colWidth + 34);
    const y = nextY[col];
    nextY[col] = y + h + 22;
    placed.push({ e, x, y, h, w: colWidth, fields });
  });

  const height = Math.max(...nextY) + 4;

  const body = placed
    .map(({ e, x, y, h, w, fields }) => {
      const stroke = e.spot ? SPOT : INK;
      const head =
        `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${headH}" ` +
        `fill="${e.spot ? SPOT : tint(4)}"/>` +
        text(x + 8, y + 16, e.name, { size: 11, weight: 700, fill: PAPER, mono: true });

      const rows = fields
        .map((f, i) => {
          const fy = y + headH + i * rowH + 11;
          const room = Math.floor((w - 16) / 5.4);
          const label = f.type ? `${f.name}  ${f.type}` : f.name;
          return (
            text(x + 8, fy, truncate(label, room), {
              size: 9,
              mono: true,
              fill: f.spot ? SPOT : INK,
              weight: f.spot ? 700 : 400,
            }) +
            (f.note
              ? text(x + w - 8, fy, truncate(f.note, 18), { size: 8, anchor: "end", fill: tint(2) })
              : "")
          );
        })
        .join("");

      return (
        `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ` +
        `fill="${PAPER}" stroke="${stroke}" stroke-width="1"/>` +
        head +
        rows
      );
    })
    .join("");

  // Connectors are drawn last so they sit above the boxes' fills but read as
  // rules rather than arrows — an arrowhead at this size is a smudge.
  const byName = new Map(placed.map((p) => [p.e.name, p]));
  const edges = relations
    .map((r) => {
      const a = byName.get(r.from);
      const b = byName.get(r.to);
      if (!a || !b || a === b) return "";
      const ax = a.x + a.w;
      const ay = a.y + a.h / 2;
      const bx = b.x;
      const by = b.y + b.h / 2;
      const mid = (ax + bx) / 2;
      return (
        `<path d="M${round(ax)} ${round(ay)} H${round(mid)} V${round(by)} H${round(bx)}" ` +
        `fill="none" stroke="${tint(2)}" stroke-width="0.75"/>` +
        (r.label
          ? text(mid + 3, (ay + by) / 2 - 3, r.label, { size: 8, fill: tint(3) })
          : "")
      );
    })
    .join("");

  return svg(width, height, edges + body, "chart--schema");
}

/* ------------------------------------------------------------------- table */

/**
 * A ruled table, for surfaces that are lists rather than quantities — API
 * routes, event names, config keys, permissions.
 *
 * A bar chart of these would be a lie: there is no magnitude, only membership,
 * and the useful column is usually the one saying which rows are unusual.
 *
 * @param {string[]} columns
 * @param {{cells:string[], spot?:boolean}[]|string[][]} rows
 */
export function table({ columns, rows, width = 620 }) {
  const cols = columns ?? [];
  const data = (rows ?? []).map((r) => (Array.isArray(r) ? { cells: r } : r));
  if (!cols.length || !data.length) return empty(width, 80, "no rows");

  const rowH = 19;
  const headH = 22;
  const height = headH + data.length * rowH + 4;
  // First column carries the identifier and gets the room; the rest split.
  const firstW = Math.min(width * 0.34, 220);
  const restW = (width - firstW) / Math.max(cols.length - 1, 1);
  const xOf = (i) => (i === 0 ? 0 : firstW + (i - 1) * restW);

  const head =
    cols
      .map((c, i) => text(xOf(i), 14, String(c).toUpperCase(), { size: 8, weight: 700, fill: tint(3) }))
      .join("") + `<line x1="0" y1="${headH - 5}" x2="${width}" y2="${headH - 5}" stroke="${INK}" stroke-width="1"/>`;

  const body = data
    .map((r, i) => {
      const y = headH + i * rowH + 12;
      const rule =
        i < data.length - 1
          ? `<line x1="0" y1="${round(y + 6)}" x2="${width}" y2="${round(y + 6)}" stroke="${RULE}" stroke-width="0.5"/>`
          : "";
      const cells = (r.cells ?? [])
        .map((c, j) => {
          const room = Math.floor(((j === 0 ? firstW : restW) - 10) / 4.6);
          return text(xOf(j), y, truncate(c, room), {
            size: 9,
            mono: j === 0,
            fill: r.spot && j === 0 ? SPOT : INK,
            weight: r.spot && j === 0 ? 700 : 400,
          });
        })
        .join("");
      return cells + rule;
    })
    .join("");

  return svg(width, height, head + body, "chart--table");
}
