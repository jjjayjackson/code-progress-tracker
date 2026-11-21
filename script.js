const track = document.querySelector("#track");
const sheet = document.querySelector("#sheet");
const sheetLabel = document.querySelector("#sheet-label");
const composer = document.querySelector("#composer");
const entriesEl = document.querySelector("#entries");
const addFileButton = document.querySelector("#add-file");
const closeButton = document.querySelector("#close-project");
const saveButton = document.querySelector("#save-project");
const stampInput = document.querySelector("#version-stamp");
const titleInput = document.querySelector("#version-title");

const STORAGE_KEY = "code-progress-tracker.project-draft";
const TAB = "    ";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let state = {
  activeId: null,
  versions: [],
};

let persistTimer = 0;
let closing = false;
let migrated = false;

function createId() {
  if (window.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyEntry() {
  return { id: createId(), name: "", content: "", comment: "" };
}

function current() {
  return state.versions.find((version) => version.id === state.activeId) || null;
}

function normalizeEntry(entry) {
  return {
    id: typeof entry?.id === "string" && entry.id ? entry.id : createId(),
    name: typeof entry?.name === "string" ? entry.name : "",
    content: typeof entry?.content === "string" ? entry.content : "",
    comment: typeof entry?.comment === "string" ? entry.comment : "",
  };
}

function normalizeVersion(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter((entry) => entry && typeof entry === "object").map(normalizeEntry) : [];
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : createId(),
    saved: raw?.saved === true,
    title: mergeTitle(
      typeof raw?.title === "string" ? raw.title : "",
      typeof raw?.description === "string" ? raw.description : "",
    ),
    createdAt: typeof raw?.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : "",
    entries,
  };
}

function formatStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = String(date.getFullYear()).slice(-2);
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${month}.${day}.${year} ${hours}:${minutes} ${suffix}`;
}

function mergeTitle(title, description) {
  const name = title.replace(/\s+$/, "");
  const notes = description.replace(/^\s+/, "");
  if (!notes.trim()) return name;
  if (!name.trim()) return notes;
  if (name.trim() === notes.trim()) return name;
  return `${name}\n\n${notes}`;
}

function versionHasContent(version) {
  if (version.title.trim()) return true;
  return version.entries.some((entry) => entry.name || entry.content || entry.comment);
}

function createVersion() {
  return {
    id: createId(),
    saved: false,
    title: "",
    createdAt: new Date().toISOString(),
    entries: [emptyEntry()],
  };
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function frameMargin() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--frame");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 24;
}

function sheetSize() {
  const styles = getComputedStyle(document.documentElement);
  const width = Number.parseFloat(styles.getPropertyValue("--sheet-w"));
  const height = Number.parseFloat(styles.getPropertyValue("--sheet-h"));
  return {
    width: Number.isFinite(width) ? width : 220,
    height: Number.isFinite(height) ? height : 140,
  };
}

function expandedRect() {
  const margin = frameMargin();
  return {
    top: margin,
    left: margin,
    width: Math.max(0, window.innerWidth - margin * 2),
    height: Math.max(0, window.innerHeight - margin * 2),
  };
}

function cardRect(version) {
  const card = version && version.saved
    ? track.querySelector(`[data-version-id="${version.id}"]`)
    : track.querySelector(".card-plus");
  if (!card) {
    const size = sheetSize();
    return {
      top: Math.max(0, (window.innerHeight - size.height) / 2),
      left: Math.max(0, (window.innerWidth - size.width) / 2),
      width: size.width,
      height: size.height,
    };
  }
  const bounds = track.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  if (rect.left < bounds.left || rect.right > bounds.right) {
    card.scrollIntoView({ inline: "center", block: "nearest" });
    return card.getBoundingClientRect();
  }
  return rect;
}

function placeSheet(rect) {
  sheet.style.position = "fixed";
  sheet.style.top = `${rect.top}px`;
  sheet.style.left = `${rect.left}px`;
  sheet.style.width = `${rect.width}px`;
  sheet.style.height = `${rect.height}px`;
}

function expandSheet(animate, origin) {
  const destination = expandedRect();
  sheet.classList.add("is-present");
  if (!animate) {
    sheet.classList.add("is-instant", "is-open");
    track.classList.add("is-instant", "is-inactive");
    placeSheet(destination);
    sheet.offsetWidth;
    sheet.classList.remove("is-instant");
    track.classList.remove("is-instant");
    return;
  }

  sheet.classList.add("is-instant");
  placeSheet(origin);
  sheet.offsetWidth;
  sheet.classList.remove("is-instant");

  requestAnimationFrame(() => {
    placeSheet(destination);
    sheet.classList.add("is-open");
    track.classList.add("is-inactive");
  });
}

function updateSheetLabel(version) {
  const titled = Boolean(version && version.saved);
  sheetLabel.textContent = titled ? version.title.trim() || "untitled" : "+";
  sheetLabel.classList.toggle("is-titled", titled);
}

function persistNow() {
  window.clearTimeout(persistTimer);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable; the in-memory draft still works.
  }
}

function schedulePersist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persistNow, 150);
}

function loadState() {
  const raw = readStored();
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    if (Array.isArray(parsed.versions)) {
      state.versions = parsed.versions.filter((version) => version && typeof version === "object").map(normalizeVersion);
      state.activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
      if (state.activeId && !current()) state.activeId = null;
    } else {
      const version = normalizeVersion(parsed);
      const keep = version.saved || parsed.open === true || versionHasContent(version);
      state.versions = keep ? [version] : [];
      state.activeId = parsed.open === true && state.versions[0] ? state.versions[0].id : null;
      migrated = keep;
    }

    const active = current();
    if (active && active.entries.length === 0) active.entries.push(emptyEntry());
  } catch {
    // Leave the stored value in place when it cannot be read.
  }
}

function entryFromElement(element) {
  const version = current();
  if (!version) return null;
  const id = element.closest(".entry")?.dataset.id;
  return version.entries.find((entry) => entry.id === id) || null;
}

function insertTab(textarea) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText(TAB, start, end, "end");
}

function outdent(textarea) {
  const value = textarea.value;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;
  const block = value.slice(blockStart, blockEnd);
  const dedented = block
    .split("\n")
    .map((line) => (line.startsWith(TAB) ? line.slice(TAB.length) : line.replace(/^ {1,3}/, "")))
    .join("\n");
  const removed = block.length - dedented.length;

  textarea.setRangeText(dedented, blockStart, blockEnd, "end");
  const nextStart = Math.max(blockStart, start - Math.min(removed, TAB.length));
  const nextEnd = Math.max(nextStart, end - removed);
  textarea.setSelectionRange(nextStart, nextEnd);
}

function onCodeKeydown(event) {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const textarea = event.currentTarget;
  if (event.shiftKey) outdent(textarea);
  else insertTab(textarea);
  const entry = entryFromElement(textarea);
  if (!entry) return;
  entry.content = textarea.value;
  schedulePersist();
}

async function pasteInto(textarea) {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    textarea.focus();
    return;
  }

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText(text, start, end, "end");
  const entry = entryFromElement(textarea);
  if (entry) entry.content = textarea.value;
  persistNow();
  textarea.focus();
}

function createEntryElement(entry) {
  const wrap = document.createElement("section");
  wrap.className = "entry";
  wrap.dataset.id = entry.id;

  const bar = document.createElement("div");
  bar.className = "entry-bar";

  const name = document.createElement("input");
  name.className = "filename";
  name.type = "text";
  name.value = entry.name;
  name.placeholder = "filename";
  name.spellcheck = false;
  name.autocomplete = "off";
  name.autocapitalize = "off";
  name.autocorrect = "off";
  name.setAttribute("aria-label", "Filename");

  const paste = document.createElement("button");
  paste.type = "button";
  paste.className = "paste";
  paste.textContent = "Paste";

  const code = document.createElement("textarea");
  code.className = "code";
  code.value = entry.content;
  code.spellcheck = false;
  code.wrap = "off";
  code.autocomplete = "off";
  code.autocapitalize = "off";
  code.autocorrect = "off";
  code.setAttribute("aria-label", "File contents");

  const comment = document.createElement("textarea");
  comment.className = "comment";
  comment.value = entry.comment;
  comment.placeholder = "comment";
  comment.setAttribute("aria-label", "Comment");

  name.addEventListener("input", () => {
    entry.name = name.value;
    schedulePersist();
  });

  code.addEventListener("input", () => {
    entry.content = code.value;
    schedulePersist();
  });
  code.addEventListener("keydown", onCodeKeydown);

  comment.addEventListener("input", () => {
    entry.comment = comment.value;
    schedulePersist();
  });

  paste.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  paste.addEventListener("click", () => {
    pasteInto(code);
  });

  bar.append(name, paste);
  wrap.append(bar, code, comment);
  return wrap;
}

function syncProjectFields() {
  const version = current();
  const stamp = version?.createdAt ? formatStamp(version.createdAt) : "";
  stampInput.value = stamp;
  stampInput.hidden = !stamp;
  titleInput.value = version ? version.title : "";
}

function renderEntries() {
  const version = current();
  const fragment = document.createDocumentFragment();
  if (version) version.entries.forEach((entry) => fragment.append(createEntryElement(entry)));
  entriesEl.replaceChildren(fragment);
}

function createArrow() {
  const arrow = document.createElement("div");
  arrow.className = "arrow";
  arrow.setAttribute("aria-hidden", "true");
  return arrow;
}

function createVersionCard(version) {
  const button = document.createElement("button");
  const title = version.title.trim() || "untitled";
  const text = document.createElement("span");
  text.className = "card-text";
  text.textContent = title;
  button.type = "button";
  button.className = "card is-titled";
  button.dataset.versionId = version.id;
  button.setAttribute("aria-label", `Open ${title}`);

  let dragged = false;
  let startY = 0;
  text.addEventListener("pointerdown", (event) => {
    dragged = false;
    startY = event.clientY;
  });
  text.addEventListener("pointermove", (event) => {
    if (Math.abs(event.clientY - startY) > 4) dragged = true;
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (dragged) {
      dragged = false;
      return;
    }
    openVersion(version.id);
  });

  button.append(text);
  return button;
}

function createPlusCard() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card card-plus";
  button.textContent = "+";
  button.setAttribute("aria-label", "New version");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const last = state.versions[state.versions.length - 1];
    const version = last && !last.saved ? last : createVersion();
    if (version !== last) state.versions.push(version);
    openVersion(version.id);
  });
  return button;
}

function renderTrack() {
  const row = document.createElement("div");
  row.className = "track-row";
  const saved = state.versions.filter((version) => version.saved);
  saved.forEach((version, index) => {
    if (index > 0) row.append(createArrow());
    row.append(createVersionCard(version));
  });
  if (saved.length > 0) row.append(createArrow());
  row.append(createPlusCard());
  track.replaceChildren(row);
}

function releaseSheet() {
  sheet.classList.add("is-instant");
  sheet.style.position = "";
  sheet.style.top = "";
  sheet.style.left = "";
  sheet.style.width = "";
  sheet.style.height = "";
  sheet.offsetWidth;
  sheet.classList.remove("is-instant");
}

function finishClose(focusId) {
  state.activeId = null;
  closing = false;
  composer.inert = true;
  sheet.setAttribute("aria-hidden", "true");
  sheet.classList.remove("is-present", "is-open");
  releaseSheet();
  persistNow();
  const button = (focusId && track.querySelector(`[data-version-id="${focusId}"]`)) || track.querySelector(".card-plus");
  button?.focus({ preventScroll: true });
}

function collapseSheet(animate, rect) {
  track.classList.remove("is-inactive");
  if (!animate) {
    finishClose(current()?.saved ? current().id : null);
    return;
  }

  placeSheet(rect);
  sheet.classList.remove("is-open");

  const focusId = current()?.saved ? current().id : null;
  const onEnd = (event) => {
    if (event.target !== sheet || event.propertyName !== "width") return;
    sheet.removeEventListener("transitionend", onEnd);
    finishClose(focusId);
  };
  sheet.addEventListener("transitionend", onEnd);
}

function closeProject() {
  if (!state.activeId || closing) return;
  const version = current();
  if (version && !version.saved && !versionHasContent(version)) {
    state.versions = state.versions.filter((item) => item.id !== version.id);
    state.activeId = null;
  }
  renderTrack();
  const staying = current();
  updateSheetLabel(staying);
  closing = true;
  collapseSheet(!reduceMotion, cardRect(staying));
}

function openVersion(id) {
  if (state.activeId || closing) return;
  const version = state.versions.find((item) => item.id === id);
  if (!version) return;
  if (version.entries.length === 0) version.entries.push(emptyEntry());
  const origin = cardRect(version);
  state.activeId = id;
  syncProjectFields();
  renderEntries();
  updateSheetLabel(version);
  composer.inert = false;
  sheet.setAttribute("aria-hidden", "false");
  persistNow();
  expandSheet(!reduceMotion, origin);

  window.setTimeout(() => {
    composer.scrollTop = 0;
    titleInput.focus({ preventScroll: true });
  }, reduceMotion ? 0 : 480);
}

function saveProject() {
  const version = current();
  if (!version) return;
  version.title = titleInput.value;
  version.saved = true;
  updateSheetLabel(version);
  renderTrack();
  persistNow();
}

function addEntry() {
  const version = current();
  if (!version) return;
  const entry = emptyEntry();
  version.entries.push(entry);
  const element = createEntryElement(entry);
  entriesEl.append(element);
  persistNow();
  element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  element.querySelector(".code")?.focus();
}

loadState();
renderTrack();
if (migrated) persistNow();

if (state.activeId) {
  syncProjectFields();
  renderEntries();
  updateSheetLabel(current());
  composer.inert = false;
  sheet.setAttribute("aria-hidden", "false");
  expandSheet(false, cardRect(current()));
}

titleInput.addEventListener("input", () => {
  const version = current();
  if (!version) return;
  version.title = titleInput.value;
  schedulePersist();
});

addFileButton.addEventListener("click", addEntry);
closeButton.addEventListener("click", closeProject);
saveButton.addEventListener("click", saveProject);

document.addEventListener("click", (event) => {
  if (!state.activeId || closing) return;
  if (sheet.contains(event.target)) return;
  closeProject();
});

window.addEventListener("resize", () => {
  if (!state.activeId && !closing) return;
  sheet.classList.add("is-instant");
  placeSheet(!closing && state.activeId ? expandedRect() : cardRect(current()));
  sheet.offsetWidth;
  sheet.classList.remove("is-instant");
});

window.addEventListener("pagehide", persistNow);
