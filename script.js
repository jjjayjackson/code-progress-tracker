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
const TABLE = "code_progress_tracker";
const TAB = "    ";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const syncApi = window.CodeProgressSync;
const supabase = createSupabase();

let state = {
  activeId: null,
  versions: [],
  deleted: [],
  updatedAt: "",
};

let persistTimer = 0;
let closing = false;
let localStatus = "missing";
let preserveCorrupt = false;
let dirtySinceLoad = false;
let needsPush = false;
let syncReady = false;
let pushChain = Promise.resolve();
let retryTimer = 0;
let pushBursts = 0;

function createSupabase() {
  const config = window.CODE_PROGRESS_SUPABASE;
  if (!config || !window.supabase || !config.url || !config.key) return null;
  try {
    return window.supabase.createClient(config.url, config.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
      },
    });
  } catch (error) {
    console.error(error);
    return null;
  }
}

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

function documentPayload() {
  return {
    activeId: state.activeId,
    versions: state.versions,
    deleted: state.deleted,
    updatedAt: state.updatedAt,
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

function versionHasContent(version) {
  if (version.title.trim()) return true;
  return version.entries.some((entry) => entry.name || entry.content || entry.comment);
}

function createVersion() {
  const now = new Date().toISOString();
  return {
    id: createId(),
    saved: false,
    title: "",
    createdAt: now,
    updatedAt: now,
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

function touchDocument() {
  state.updatedAt = new Date().toISOString();
}

function touchVersion(version) {
  const now = new Date().toISOString();
  state.updatedAt = now;
  if (version) version.updatedAt = now;
}

function writeLocal() {
  if (preserveCorrupt) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(documentPayload()));
    localStatus = "ok";
  } catch {
    // Storage can be unavailable; the in-memory draft still works.
  }
}

function persistNow(kind) {
  window.clearTimeout(persistTimer);
  if (kind === "version") touchVersion(current());
  else if (kind === "document") touchDocument();
  if (kind === "version" || kind === "document") {
    preserveCorrupt = false;
    dirtySinceLoad = true;
    needsPush = true;
  }
  writeLocal();
  requestPush();
}

function schedulePersist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => persistNow("version"), 150);
}

function ensureActiveEntry() {
  const active = current();
  if (active && active.entries.length === 0) active.entries.push(emptyEntry());
}

function loadState() {
  const raw = readStored();
  if (raw == null) {
    localStatus = "missing";
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const normalized = syncApi.normalizeState(parsed);
    if (!normalized) {
      localStatus = "corrupt";
      preserveCorrupt = true;
      return;
    }
    state = normalized;
    localStatus = "ok";
    ensureActiveEntry();
  } catch {
    localStatus = "corrupt";
    preserveCorrupt = true;
  }
}

function scheduleRetry() {
  if (retryTimer || !needsPush) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    pushBursts = 0;
    requestPush();
  }, 8000);
}

function requestPush() {
  if (!syncReady || !needsPush || !supabase) return;
  pushChain = pushChain.then(pushLatest).catch((error) => {
    console.error(error);
    scheduleRetry();
  });
}

async function fetchRemote() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("active_id, versions, deleted, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const normalized = syncApi.normalizeState({
    activeId: data.active_id,
    versions: data.versions,
    deleted: data.deleted,
    updatedAt: data.updated_at,
  });
  if (!normalized) throw new Error("Supabase returned an unreadable code-progress document.");
  return normalized;
}

function applyDocument(next, remote) {
  const previousActive = current();
  const sheetOpen = sheet.classList.contains("is-present");
  const before = syncApi.signature(state);
  state.activeId = next.activeId;
  state.versions = next.versions;
  state.deleted = next.deleted;
  state.updatedAt = next.updatedAt;
  ensureActiveEntry();
  needsPush = syncApi.signature(state) !== syncApi.signature(remote);
  preserveCorrupt = false;
  writeLocal();
  if (syncApi.signature(state) === before) return;

  renderTrack();
  const version = current();
  if (!version) {
    if (sheetOpen) {
      closing = false;
      composer.inert = true;
      sheet.setAttribute("aria-hidden", "true");
      sheet.classList.remove("is-present", "is-open");
      track.classList.remove("is-inactive");
      releaseSheet();
    }
    return;
  }

  const focused = composer.contains(document.activeElement);
  if (sheetOpen && focused && version === previousActive) return;

  if (!sheetOpen) {
    if (dirtySinceLoad) return;
    syncProjectFields();
    renderEntries();
    updateSheetLabel(version);
    composer.inert = false;
    sheet.setAttribute("aria-hidden", "false");
    expandSheet(false, cardRect(version));
    return;
  }

  syncProjectFields();
  renderEntries();
  updateSheetLabel(version);
}

async function pushLatest() {
  if (!needsPush || !supabase) return;
  if (pushBursts > 4) {
    scheduleRetry();
    return;
  }
  pushBursts += 1;
  if (!state.updatedAt) touchDocument();

  const snapshot = JSON.parse(JSON.stringify(documentPayload()));
  const sentSignature = syncApi.signature(snapshot);
  const { data, error } = await supabase.rpc("save_code_progress_tracker", {
    p_active_id: snapshot.activeId,
    p_versions: snapshot.versions,
    p_deleted: snapshot.deleted,
    p_updated_at: snapshot.updatedAt,
  });
  if (error) throw error;

  if (!data || data.applied === false) {
    const remote = syncApi.normalizeState({
      activeId: data?.active_id,
      versions: data?.versions,
      deleted: data?.deleted,
      updatedAt: data?.updated_at,
    });
    if (remote) {
      const merged = syncApi.mergeStates(state, remote);
      applyDocument(merged, remote);
    }
  } else {
    pushBursts = 0;
    if (syncApi.signature(state) === sentSignature) {
      needsPush = false;
      if (typeof data.updated_at === "string" && data.updated_at) state.updatedAt = data.updated_at;
      writeLocal();
    }
  }

  if (needsPush) requestPush();
}

async function boot() {
  if (!supabase) return;

  let remote = null;
  try {
    remote = await fetchRemote();
  } catch (error) {
    console.error(error);
    syncReady = true;
    if (localStatus === "ok") {
      needsPush = true;
      scheduleRetry();
    }
    return;
  }

  if (localStatus === "corrupt") {
    if (remote) {
      state = remote;
      ensureActiveEntry();
      needsPush = false;
      preserveCorrupt = false;
      writeLocal();
      renderTrack();
      if (state.activeId) {
        syncProjectFields();
        renderEntries();
        updateSheetLabel(current());
        composer.inert = false;
        sheet.setAttribute("aria-hidden", "false");
        expandSheet(false, cardRect(current()));
      }
    }
  } else {
    const remoteState = remote || { activeId: null, versions: [], deleted: [], updatedAt: "" };
    const merged = syncApi.mergeStates(state, remoteState);
    applyDocument(merged, remoteState);
  }

  syncReady = true;
  if (needsPush) requestPush();
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

function createEntryElement(entry) {
  const wrap = document.createElement("section");
  wrap.className = "entry";
  wrap.dataset.id = entry.id;

  const code = document.createElement("textarea");
  code.className = "code";
  code.value = entry.content;
  code.spellcheck = false;
  code.wrap = "off";
  code.autocomplete = "off";
  code.autocapitalize = "off";
  code.autocorrect = "off";
  code.setAttribute("aria-label", "Code");

  code.addEventListener("input", () => {
    entry.content = code.value;
    schedulePersist();
  });
  code.addEventListener("keydown", onCodeKeydown);

  wrap.append(code);
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
  persistNow("document");
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
    const deletedAt = new Date().toISOString();
    state.deleted = state.deleted.filter((item) => item.id !== version.id);
    state.deleted.push({ id: version.id, deletedAt });
    state.versions = state.versions.filter((item) => item.id !== version.id);
    state.updatedAt = deletedAt;
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
  persistNow("document");
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
  persistNow("version");
}

function addEntry() {
  const version = current();
  if (!version) return;
  const entry = emptyEntry();
  version.entries.push(entry);
  const element = createEntryElement(entry);
  entriesEl.append(element);
  persistNow("version");
  element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  element.querySelector(".code")?.focus();
}

loadState();
renderTrack();

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

window.addEventListener("pagehide", () => {
  if (persistTimer) persistNow("version");
  else persistNow("keep");
});

window.addEventListener("online", () => {
  if (!needsPush) return;
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  pushBursts = 0;
  requestPush();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !needsPush) return;
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  pushBursts = 0;
  requestPush();
});

boot();
