# site/public — the deploy directory

Cloudflare serves this directory verbatim (`site/wrangler.jsonc` → `assets`).
Everything the installer downloads has to physically exist here at deploy time,
so some of these files are **copies**, not sources.

| File | Source of truth | Edit here? |
| --- | --- | --- |
| `index.html`, `terms.html`, `privacy.html`, `paid.html` | this directory | yes |
| `install` | this directory | yes |
| `SKILL.md`, `APPLY.md` | `../../loop/` | **no** — regenerated |
| `nightly.sh`, `collect.sh` | `../../loop/` | **no** — regenerated |
| `screenless.tar.gz` | `../../cli/dist` | **no** — regenerated |

Regenerate with `npm --prefix cli run bundle`, which is also what stops the
copies drifting from their sources.

Editing a copy here loses your work on the next bundle. That is the one trap in
this layout, and the reason this file exists.
