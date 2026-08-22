/**
 * Every mail screenless sends, in one visual frame that matches the site: the
 * logo and wordmark, a white card on a soft grey ground, a system sans face.
 * Table-based layout because email clients are where CSS goes to die, and the
 * logo is a hosted PNG because Gmail strips inline SVG.
 *
 * Nothing here ever ships markdown to an inbox: callers hand over either
 * ready HTML or markdown-ish text that `mdToHtml` renders first.
 */

import type { Env } from "./index";

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LOGO_URL = "https://screenless.sh/logo.png";

/**
 * The email font stack. Deliberately web-safe — email clients do not load web
 * fonts reliably, so this mirrors the site's Inter with the system UI faces
 * that actually render in a mailbox.
 */
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

/** Wraps body HTML in the branded frame. `preheader` is the inbox preview line. */
export function layout(env: Env, bodyHtml: string, preheader = ""): string {
  const site = env.SITE_URL || "https://screenless.sh";
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background-color:#f7f8fb;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;">${esc(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f8fb;">
<tr><td align="center" style="padding:36px 16px;">
  <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;">
    <tr><td style="padding:0 4px 20px 4px;">
      <a href="${site}" style="text-decoration:none;">
        <img src="${LOGO_URL}" width="20" height="33" alt="" style="vertical-align:middle;border:0;">
        <span style="font-family:${FONT};font-size:19px;font-weight:700;letter-spacing:-.02em;color:#0c0e14;vertical-align:middle;padding-left:9px;">screenless</span>
      </a>
    </td></tr>
    <tr><td style="background-color:#ffffff;border:1px solid #e8eaf0;border-radius:16px;padding:32px 34px;font-family:${FONT};font-size:16px;line-height:1.6;color:#0c0e14;">
${bodyHtml}
    </td></tr>
    <tr><td style="padding:18px 4px;font-family:${FONT};font-size:13px;color:#9aa1b2;">
      A phone line for your team and its coding agents ·
      <a href="${site}" style="color:#9aa1b2;">screenless.sh</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** The one button style: ink pill, matching the site's primary action. */
export const button = (href: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:10px;background-color:#0c0e14;">
    <a href="${href}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-weight:600;font-size:15px;color:#ffffff;text-decoration:none;">${esc(label)}</a>
  </td></tr></table>`;

/** A code the reader types somewhere else, set large so it can be read across the room. */
export const codeBlock = (code: string): string =>
  `<div style="margin:22px 0;padding:16px 18px;background-color:#f7f8fb;border:1px solid #e8eaf0;border-radius:12px;font-family:${MONO};font-size:28px;font-weight:500;letter-spacing:6px;color:#0c0e14;text-align:center;">${esc(code)}</div>`;

/* -------------------------------------------------------------- md → html */

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, `<code style="font-family:${MONO};font-size:.9em;background-color:#f7f8fb;border:1px solid #e8eaf0;padding:1px 5px;border-radius:5px;">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" style="color:#c23a1f;">$1</a>');
}

/**
 * The subset of markdown the loop's reports actually use: headings, bold,
 * italics, inline code, links, lists, fences, paragraphs. Anything fancier
 * degrades to a paragraph rather than leaking `**` into an inbox.
 */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let list: "ul" | "ol" | null = null;
  let fence: string[] | null = null;

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const raw of lines) {
    if (fence) {
      if (/^```/.test(raw)) {
        out.push(
          `<pre style="background-color:#f7f8fb;border:1px solid #e8eaf0;padding:12px 14px;border-radius:10px;font-family:${MONO};font-size:13px;overflow-x:auto;">${esc(fence.join("\n"))}</pre>`,
        );
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^```/.test(raw)) {
      closeList();
      fence = [];
      continue;
    }

    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const size = [22, 19, 17][h[1].length - 1];
      out.push(`<h${h[1].length + 1} style="font-size:${size}px;font-weight:700;letter-spacing:-.01em;margin:22px 0 8px 0;color:#0c0e14;">${inline(h[2])}</h${h[1].length + 1}>`);
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        closeList();
        out.push(`<${want} style="margin:8px 0;padding-left:22px;">`);
        list = want;
      }
      out.push(`<li style="margin:4px 0;">${inline((ul ?? ol)![1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p style="margin:10px 0;">${inline(line)}</p>`);
  }
  closeList();
  if (fence) out.push(`<pre>${esc((fence as string[]).join("\n"))}</pre>`);
  return out.join("\n");
}
