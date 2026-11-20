const editor = document.querySelector("#code");
const notes = document.querySelector("#notes");
const prevFileButton = document.querySelector("#prev-file");
const nextFileButton = document.querySelector("#next-file");
const savePageButton = document.querySelector("#save-page");
const gutterLines = document.querySelector("#gutter-lines");
const activeLine = document.querySelector("#active-line");

const CODE_KEY = "code-progress-tracker.code";
const FILES_KEY = "code-progress-tracker.files";
const ACTIVE_KEY = "code-progress-tracker.active-file";
const NOTES_KEY = "code-progress-tracker.notes";
const TAB = "    ";
const LINE_HEIGHT = 22;
const PAD_TOP = 4;

function lineCount() {
  const value = editor.value;
  if (value.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function activeLineIndex() {
  const caret = editor.selectionStart;
  let index = 0;
  for (let i = 0; i < caret; i += 1) {
    if (editor.value.charCodeAt(i) === 10) index += 1;
  }
  return index;
}

function render() {
  const count = lineCount();
  const current = activeLineIndex();
  const numbers = [];

  for (let i = 1; i <= count; i += 1) {
    const active = i - 1 === current ? " active" : "";
    numbers.push(`<div class="ln${active}">${i}</div>`);
  }

  gutterLines.innerHTML = numbers.join("");
  syncScroll();
}

function syncScroll() {
  const offset = PAD_TOP + activeLineIndex() * LINE_HEIGHT - editor.scrollTop;
  gutterLines.style.transform = `translateY(${-editor.scrollTop}px)`;
  activeLine.style.transform = `translateY(${offset}px)`;
}

function insertTab() {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(TAB, start, end, "end");
}

function outdent() {
  const value = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;
  const block = value.slice(blockStart, blockEnd);
  const dedented = block
    .split("\n")
    .map((line) => (line.startsWith(TAB) ? line.slice(TAB.length) : line.replace(/^ {1,3}/, "")))
    .join("\n");
  const removed = block.length - dedented.length;

  editor.setRangeText(dedented, blockStart, blockEnd, "end");
  const nextStart = Math.max(blockStart, start - Math.min(removed, TAB.length));
  const nextEnd = Math.max(nextStart, end - removed);
  editor.setSelectionRange(nextStart, nextEnd);
}

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function markSaved(button) {
  button.textContent = "Saved";
  window.clearTimeout(button._savedTimer);
  button._savedTimer = window.setTimeout(() => {
    button.textContent = "Save";
  }, 1000);
}

function createId() {
  if (window.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function currentFile() {
  return files.find((file) => file.id === activeId) || null;
}

function rememberCurrent() {
  const file = currentFile();
  if (!file) return;
  file.content = editor.value;
  file.notes = notes.value;
}

function showFile(id) {
  const file = files.find((item) => item.id === id);
  if (!file) return;
  activeId = file.id;
  editor.value = file.content;
  notes.value = file.notes;
  editor.scrollTop = 0;
  notes.scrollTop = 0;
  updateArrows();
  render();
}

function fileIndex() {
  return files.findIndex((file) => file.id === activeId);
}

function updateArrows() {
  const index = fileIndex();
  const atEnd = index === files.length - 1;
  prevFileButton.disabled = index <= 0;
  nextFileButton.setAttribute("aria-label", atEnd ? "Add file" : "Next file");
}

function addFile() {
  rememberCurrent();
  const file = {
    id: createId(),
    name: `File ${files.length + 1}`,
    content: "",
    notes: "",
  };
  files.push(file);
  showFile(file.id);
  editor.focus();
}

function stepFile(direction) {
  const next = files[fileIndex() + direction];
  if (!next) {
    if (direction > 0) addFile();
    return;
  }
  rememberCurrent();
  showFile(next.id);
  editor.focus();
}

function loadFiles() {
  const storedFiles = readStored(FILES_KEY);
  if (storedFiles) {
    try {
      const parsed = JSON.parse(storedFiles);
      if (Array.isArray(parsed) && parsed.length > 0) {
        files = parsed.map((file, index) => ({
          id: typeof file.id === "string" ? file.id : createId(),
          name: typeof file.name === "string" ? file.name : `File ${index + 1}`,
          content: typeof file.content === "string" ? file.content : "",
          notes: typeof file.notes === "string" ? file.notes : "",
        }));
        const storedActive = readStored(ACTIVE_KEY);
        activeId = files.some((file) => file.id === storedActive) ? storedActive : files[0].id;
        attachLegacyNotes();
        return;
      }
    } catch {
      files = [];
    }
  }

  const legacy = readStored(CODE_KEY);
  files = [
    {
      id: createId(),
      name: "File 1",
      content: legacy === null ? "" : legacy,
      notes: "",
    },
  ];
  activeId = files[0].id;
  attachLegacyNotes();
}

function attachLegacyNotes() {
  const legacyNotes = readStored(NOTES_KEY);
  if (legacyNotes === null || !files[0]) return;
  if (files.some((file) => file.notes)) return;
  files[0].notes = legacyNotes;
}

function persistFiles() {
  rememberCurrent();
  localStorage.setItem(FILES_KEY, JSON.stringify(files));
  localStorage.setItem(ACTIVE_KEY, activeId);
  const first = files[0];
  if (first) {
    localStorage.setItem(CODE_KEY, first.content);
    localStorage.setItem(NOTES_KEY, first.notes);
  }
}

function savePage() {
  persistFiles();
  markSaved(savePageButton);
}

let files = [];
let activeId = null;

loadFiles();
const openedFile = currentFile();
editor.value = openedFile ? openedFile.content : "";
notes.value = openedFile ? openedFile.notes : "";
updateArrows();

editor.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  event.preventDefault();
  if (event.shiftKey) outdent();
  else insertTab();
  rememberCurrent();
  render();
});

editor.addEventListener("input", () => {
  rememberCurrent();
  render();
});
editor.addEventListener("keyup", render);
editor.addEventListener("click", render);
editor.addEventListener("scroll", syncScroll);
notes.addEventListener("input", rememberCurrent);
prevFileButton.addEventListener("click", () => stepFile(-1));
nextFileButton.addEventListener("click", () => stepFile(1));
savePageButton.addEventListener("click", savePage);

editor.focus();
render();
