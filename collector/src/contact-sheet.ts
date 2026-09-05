/**
 * The `index.html` that goes inside a screenshot bundle.
 *
 * Its own module because two workloads produce the same artifact for the same
 * reason: locale-shots captures one column per locale, a11y-audit one per
 * display condition, and in both cases the review that matters is a horizontal
 * scan across one screen -- a string that did not translate, a label clipped by
 * a longer one, a layout that did not mirror, a button that grew to two lines
 * at the largest text size. None of that is visible in a directory of PNGs, and
 * a zip a person has to unpack and open file by file is a zip nobody reviews.
 *
 * Pure, so the page can be asserted on without a device attached.
 */

export type SheetShot = {
  /** The column this shot belongs in: a locale tag, or a display condition. */
  column: string;
  /** Render this column's cells right-to-left. */
  rtl?: boolean;
  device: string;
  /** The screen's name, e.g. "home". Becomes a row. */
  shot: string;
  /** Path inside the bundle, or null when this cell has no image. */
  file: string | null;
  /** Why there is no image, or anything worth saying about this one. */
  note?: string;
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One row per screen, one column per locale or condition.
 *
 * RTL columns are marked in the header AND rendered `dir="rtl"`, because the
 * most common real localisation defect is a screen that translated correctly
 * and did not mirror, and that is only obvious next to a header saying it
 * should have.
 *
 * A missing shot is a visible, labelled hole rather than an empty cell. An
 * empty cell lets a column that captured nothing read as a column with nothing
 * to report, which is the same failure as a green row that measured nothing.
 */
export function contactSheetHtml(
  title: string,
  shots: SheetShot[],
  opts: { columnNoun?: string; subtitle?: string } = {},
): string {
  const noun = opts.columnNoun ?? "locale";
  const columns: string[] = [];
  const rtlOf = new Map<string, boolean>();
  for (const s of shots) {
    if (!columns.includes(s.column)) columns.push(s.column);
    if (s.rtl) rtlOf.set(s.column, true);
  }
  // Rows are (device, screen) pairs in first-seen order -- the flow's own
  // order, which is the order a person walked the app in.
  const rows: { device: string; shot: string }[] = [];
  for (const s of shots) {
    if (!rows.some((r) => r.device === s.device && r.shot === s.shot)) {
      rows.push({ device: s.device, shot: s.shot });
    }
  }

  const cell = (device: string, shot: string, column: string): string => {
    const s = shots.find((x) => x.device === device && x.shot === shot && x.column === column);
    if (!s || !s.file) {
      return `<td class="miss"><div class="hole">no shot</div>${
        s?.note ? `<p class="note">${esc(s.note)}</p>` : ""}</td>`;
    }
    return `<td${rtlOf.get(column) ? ' dir="rtl"' : ""}><a href="${esc(s.file)}">` +
      `<img loading="lazy" src="${esc(s.file)}" alt="${esc(`${shot} — ${column}`)}"></a>` +
      (s.note ? `<p class="note">${esc(s.note)}</p>` : "") + "</td>";
  };

  const missing = shots.filter((s) => !s.file).length;
  const sub = opts.subtitle ??
    `${columns.length} ${noun}(s) &middot; ${rows.length} screen(s) &middot; ${shots.length - missing} shot(s)` +
    (missing ? ` &middot; <strong>${missing} missing</strong>` : "");

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --miss: #c0392b; }
  body { margin: 0; padding: 24px; font: 14px/1.45 -apple-system, system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; opacity: .7; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid var(--line); padding: 8px; vertical-align: top; text-align: left; }
  th.row { position: sticky; left: 0; background: Canvas; white-space: nowrap; }
  thead th { position: sticky; top: 0; background: Canvas; }
  img { display: block; width: 240px; height: auto; border: 1px solid var(--line); }
  .tag { font-size: 11px; font-weight: 600; letter-spacing: .04em; opacity: .75; }
  .hole { width: 240px; height: 140px; display: grid; place-items: center;
          border: 1px dashed var(--miss); color: var(--miss); font-weight: 600; }
  .note { margin: 6px 0 0; font-size: 11px; opacity: .75; max-width: 240px; }
  .miss { background: color-mix(in srgb, var(--miss) 8%, transparent); }
</style>
<h1>${esc(title)}</h1>
<p class="sub">${sub}</p>
<div class="wrap">
<table>
<thead><tr><th class="row">screen</th>${
    columns.map((c) => `<th>${esc(c)}${rtlOf.get(c) ? '<div class="tag">RTL</div>' : ""}</th>`).join("")
  }</tr></thead>
<tbody>
${rows.map((r) =>
    `<tr><th class="row">${esc(r.shot)}<div class="tag">${esc(r.device)}</div></th>` +
    columns.map((c) => cell(r.device, r.shot, c)).join("") + "</tr>").join("\n")}
</tbody>
</table>
</div>
</html>
`;
}
