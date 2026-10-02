/**
 * A small Markdown renderer for the in-game guide. Pure and DOM-free so it can
 * be tested under node. Supports headings, paragraphs, bullet and numbered lists
 * (nested by indentation), fenced code, rules, bold, italic, inline code, links
 * and GFM tables. Source text is HTML-escaped before anything else happens.
 */

/** The guide pages by the file name the Markdown links to. */
export const GUIDE_PAGE_FILES: Readonly<Record<string, string>> = {
  "1-overview.md": "overview",
  "2-how-it-plays.md": "how-it-plays",
  "3-encyclopedia.md": "encyclopedia",
};

export interface RenderOptions {
  /** The page being rendered: prefixes heading ids and scopes `#section` links. */
  page?: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** "How it plays, and why" becomes "how-it-plays-and-why". */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Where a link in the Markdown should point inside the viewer, or undefined for an unsafe one. */
export function rewriteHref(href: string, page?: string): { href: string; external: boolean } | undefined {
  const file = /^([\w-]+\.md)(?:#([\w-]+))?$/.exec(href);
  if (file && GUIDE_PAGE_FILES[file[1]]) {
    const target = GUIDE_PAGE_FILES[file[1]];
    return { href: file[2] ? `#${target}/${file[2]}` : `#${target}`, external: false };
  }
  if (href.startsWith("#")) return { href: page ? `#${page}/${href.slice(1)}` : href, external: false };
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return { href, external: true };
  return undefined;
}

function inline(source: string, options: RenderOptions): string {
  const stash: string[] = [];
  const hold = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`;
  let text = escapeHtml(source);
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => hold(`<code>${code}</code>`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const target = rewriteHref(href.replace(/&amp;/g, "&"), options.page);
    if (!target) return label;
    const attributes = target.external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return hold(`<a href="${escapeHtml(target.href)}"${attributes}>${emphasis(label)}</a>`);
  });
  text = emphasis(text);
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => stash[Number(index)]);
}

function emphasis(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
}

interface ListItem { indent: number; ordered: boolean; text: string }

function renderList(items: ListItem[], start: number, options: RenderOptions): [string, number] {
  const indent = items[start].indent;
  const tag = items[start].ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  let index = start;
  while (index < items.length && items[index].indent >= indent) {
    if (items[index].ordered !== (tag === "ol") && items[index].indent === indent) break;
    let content = inline(items[index].text, options);
    index++;
    if (index < items.length && items[index].indent > indent) {
      const [nested, next] = renderList(items, index, options);
      content += nested;
      index = next;
    }
    html += `<li>${content}</li>`;
  }
  return [`${html}</${tag}>`, index];
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

function renderTable(header: string, separator: string, rows: string[], options: RenderOptions): string {
  const align = splitRow(separator).map(cell => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
  const cell = (tag: string, text: string, column: number): string => {
    const style = align[column] ? ` style="text-align:${align[column]}"` : "";
    return `<${tag}${style}>${inline(text, options)}</${tag}>`;
  };
  const head = splitRow(header).map((text, column) => cell("th", text, column)).join("");
  const body = rows.map(row => `<tr>${splitRow(row).map((text, column) => cell("td", text, column)).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Renders Markdown source to an HTML string. */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  const startsBlock = (line: string): boolean => /^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|\s*(-{3,}|\*{3,})\s*$)/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      index++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = options.page ? `${options.page}--${slugify(heading[2])}` : slugify(heading[2]);
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(heading[2], options)}</h${level}>`);
      index++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); index++; continue; }
    if (line.includes("|") && index + 1 < lines.length && SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      const header = line;
      const separator = lines[index + 1];
      index += 2;
      const rows: string[] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) rows.push(lines[index++]);
      out.push(renderTable(header, separator, rows, options));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        const match = LIST_ITEM.exec(lines[index]);
        if (match) {
          items.push({ indent: match[1].replace(/\t/g, "    ").length, ordered: /\d/.test(match[2]), text: match[3] });
          index++;
        } else if (lines[index].trim() && /^\s+\S/.test(lines[index]) && items.length) {
          items[items.length - 1].text += ` ${lines[index].trim()}`;
          index++;
        } else break;
      }
      let at = 0;
      while (at < items.length) {
        const [html, next] = renderList(items, at, options);
        out.push(html);
        at = next;
      }
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && !(lines[index].includes("|") && index + 1 < lines.length && SEPARATOR.test(lines[index + 1]))) {
      paragraph.push(lines[index++].trim());
    }
    out.push(`<p>${inline(paragraph.join(" "), options)}</p>`);
  }
  return out.join("\n");
}
