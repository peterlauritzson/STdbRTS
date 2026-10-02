import "./guide.css";
import overview from "../docs/guide/1-overview.md?raw";
import howItPlays from "../docs/guide/2-how-it-plays.md?raw";
import encyclopedia from "../docs/guide/3-encyclopedia.md?raw";
import { renderMarkdown } from "./markdown";

/** The three pages, in tab order. The Markdown files are the source of truth. */
const PAGES = [
  { id: "overview", source: overview },
  { id: "how-it-plays", source: howItPlays },
  { id: "encyclopedia", source: encyclopedia },
] as const;

const container = document.getElementById("guide") as HTMLElement;
const tabs = [...document.querySelectorAll<HTMLAnchorElement>("#guide-tabs a")];

// Each page starts with a one-line navigation row for readers of the raw files;
// the tabs replace it here.
const NAV_LINE = /^\[Overview\][^\n]*\n+/;
const sections = new Map<string, HTMLElement>();
for (const page of PAGES) {
  const section = document.createElement("article");
  section.id = `page-${page.id}`;
  section.hidden = true;
  section.innerHTML = renderMarkdown(page.source.replace(NAV_LINE, ""), { page: page.id });
  container.append(section);
  sections.set(page.id, section);
}

/** `#encyclopedia/units` is page `encyclopedia`, heading `units`. */
function parseHash(hash: string): { page: string; section?: string } {
  const [name, section] = decodeURIComponent(hash.replace(/^#/, "")).split("/");
  return { page: sections.has(name) ? name : PAGES[0].id, section: section || undefined };
}

let shown = "";
function route(): void {
  const { page, section } = parseHash(location.hash);
  if (page !== shown) {
    for (const [id, element] of sections) element.hidden = id !== page;
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.page === page));
    shown = page;
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  if (section) document.getElementById(`${page}--${section}`)?.scrollIntoView();
}

window.addEventListener("hashchange", route);
route();
