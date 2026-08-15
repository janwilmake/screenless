#!/usr/bin/env node
/**
 * Turns an edition into a printable PDF.
 *
 *   node press/bin/render.mjs edition.json --out ~/press/2026-08-15.pdf
 *
 * The edition is authored by the skill (what matters, what to say); this script
 * only lays it out. Everything is inlined — SVG is generated here, images are
 * embedded as data URIs — so the PDF has no external references and renders the
 * same whether it is mailed, printed, or opened a year from now.
 *
 * PDF generation uses headless Chrome, which is already installed on any machine
 * running the browser half of this product. That avoids a puppeteer dependency
 * and the ~300MB Chromium download that comes with it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, extname, join } from "node:path";
import { tmpdir } from "node:os";
import * as charts from "../lib/charts.mjs";

/* -------------------------------------------------------------------- args */

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const EDITION = resolve(positional[0] ?? "edition.json");
if (!existsSync(EDITION)) {
  console.error(`edition not found: ${EDITION}`);
  process.exit(1);
}

const edition = JSON.parse(readFileSync(EDITION, "utf8"));
const OUT = resolve(flag("out", `press-${edition.date ?? "edition"}.pdf`));
const KEEP_HTML = args.includes("--keep-html");

const CHROME =
  flag("chrome") ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));

/* ------------------------------------------------------------------ assets */

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** Inline an image so the PDF carries no external references. */
function dataUri(path) {
  const abs = resolve(dirname(EDITION), path);
  if (!existsSync(abs)) return null;
  const mime = MIME[extname(abs).toLowerCase()];
  if (!mime) return null;
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}

/* ------------------------------------------------------------------ charts */

/** Map an edition chart spec onto the chart library. */
function renderChart(spec) {
  if (!spec || typeof spec !== "object") return "";
  const { type, caption } = spec;
  let body = "";

  switch (type) {
    case "treemap":
      body = charts.treemap({ items: spec.items ?? [], height: spec.height ?? 320 });
      break;
    case "bar":
      body = charts.barChart({ items: spec.items ?? [], labelWidth: spec.labelWidth ?? 190 });
      break;
    case "status":
      body = charts.statusBar({ segments: spec.segments ?? spec.items ?? [] });
      break;
    case "age":
      body = charts.agePlot({ items: spec.items ?? [], threshold: spec.threshold ?? 7 });
      break;
    case "spark":
      body = charts.sparkline({ values: spec.values ?? [], spot: spec.spot });
      break;
    case "schema":
      body = charts.schema({ entities: spec.entities ?? [], relations: spec.relations ?? [] });
      break;
    case "table":
      body = charts.table({ columns: spec.columns ?? [], rows: spec.rows ?? [] });
      break;
    default:
      return `<div class="chart-missing">unknown chart type: ${charts.esc(type)}</div>`;
  }

  return `<figure class="figure">${body}${
    caption ? `<figcaption>${charts.esc(caption)}</figcaption>` : ""
  }</figure>`;
}

/* ------------------------------------------------------------------- pages */

function statTile(s) {
  const spark = Array.isArray(s.spark) && s.spark.length > 1
    ? charts.sparkline({ values: s.spark, spot: s.spot })
    : "";
  return `<div class="stat${s.spot ? " stat--spot" : ""}">
    <div class="stat__value">${charts.esc(s.value)}</div>
    <div class="stat__label">${charts.esc(s.label)}</div>
    ${spark ? `<div class="stat__spark">${spark}</div>` : ""}
  </div>`;
}

function masthead(m = {}, meta = {}) {
  return `<header class="masthead">
    <div class="masthead__rule"></div>
    <div class="masthead__top">
      <span class="masthead__name">screenless</span>
      <span class="masthead__meta">${charts.esc(meta.repo ?? "")} · ${charts.esc(meta.date ?? "")}</span>
    </div>
    <h1 class="masthead__headline">${charts.esc(m.headline ?? "")}</h1>
    ${m.standfirst ? `<p class="masthead__standfirst">${charts.esc(m.standfirst)}</p>` : ""}
    ${
      Array.isArray(m.stats) && m.stats.length
        ? `<div class="stats">${m.stats.map(statTile).join("")}</div>`
        : ""
    }
  </header>`;
}

function ticketPage(p) {
  const img = p.image ? dataUri(p.image) : null;
  return `<section class="page page--ticket">
    <div class="page__head">
      <span class="tag">${charts.esc(p.id ?? "")}</span>
      ${p.status ? `<span class="tag tag--muted">${charts.esc(p.status)}</span>` : ""}
      ${p.pr ? `<span class="tag tag--muted">#${charts.esc(p.pr)}</span>` : ""}
    </div>
    <h2 class="page__title">${charts.esc(p.title ?? "")}</h2>
    ${p.caption ? `<p class="page__caption">${charts.esc(p.caption)}</p>` : ""}
    ${img ? `<div class="shot"><img src="${img}" alt=""/></div>` : ""}
    ${(p.charts ?? []).map(renderChart).join("")}
    ${
      p.decision
        ? `<div class="decision"><span class="decision__label">needs you</span>${charts.esc(p.decision)}</div>`
        : ""
    }
  </section>`;
}

function genericPage(p) {
  const img = p.image ? dataUri(p.image) : null;
  return `<section class="page">
    <h2 class="page__title">${charts.esc(p.title ?? "")}</h2>
    ${p.caption ? `<p class="page__caption">${charts.esc(p.caption)}</p>` : ""}
    ${img ? `<div class="shot"><img src="${img}" alt=""/></div>` : ""}
    ${(p.charts ?? []).map(renderChart).join("")}
    ${
      Array.isArray(p.notes) && p.notes.length
        ? `<ul class="notes">${p.notes.map((n) => `<li>${charts.esc(n)}</li>`).join("")}</ul>`
        : ""
    }
  </section>`;
}

const page = (p) => (p.kind === "ticket" ? ticketPage(p) : genericPage(p));

/* -------------------------------------------------------------------- html */

const css = readFileSync(new URL("../templates/edition.css", import.meta.url), "utf8");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>screenless · ${charts.esc(edition.repo ?? "")} · ${charts.esc(edition.date ?? "")}</title>
<style>${css}</style></head>
<body>
${masthead(edition.masthead, { repo: edition.repo, date: edition.date })}
${(edition.pages ?? []).map(page).join("\n")}
<footer class="colophon">
  Generated ${charts.esc(edition.generatedAt ?? new Date().toISOString())} ·
  ${charts.esc(edition.repo ?? "")} ${charts.esc(edition.head ?? "")} ·
  read it once, then recycle it
</footer>
</body></html>`;

/* --------------------------------------------------------------------- pdf */

const work = join(tmpdir(), `screenless-press-${Date.now()}`);
mkdirSync(work, { recursive: true });
const htmlPath = join(work, "edition.html");
writeFileSync(htmlPath, html);

mkdirSync(dirname(OUT), { recursive: true });

if (!CHROME) {
  console.error("no Chrome/Chromium found — pass --chrome <path>. HTML written to:");
  console.error(htmlPath);
  process.exit(2);
}

try {
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--no-sandbox",
      `--print-to-pdf=${OUT}`,
      `file://${htmlPath}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
  );
} catch (err) {
  console.error(`chrome failed to render: ${err.message}`);
  console.error(`HTML left at ${htmlPath}`);
  process.exit(3);
}

if (KEEP_HTML) console.error(`html: ${htmlPath}`);
else rmSync(work, { recursive: true, force: true });

process.stdout.write(`${OUT}\n`);
