/**
 * Document merge for code-progress-tracker.
 * Supabase is authoritative when it is reachable. Local versions win only when
 * their updatedAt is newer, and versions that exist on only one side are kept.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodeProgressSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `version-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function timestampMs(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  function validIso(value) {
    return typeof value === "string" && timestampMs(value) > 0;
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

  function normalizeEntry(entry) {
    return {
      id: typeof entry?.id === "string" && entry.id ? entry.id : createId(),
      name: typeof entry?.name === "string" ? entry.name : "",
      content: typeof entry?.content === "string" ? entry.content : "",
      comment: typeof entry?.comment === "string" ? entry.comment : "",
    };
  }

  function normalizeVersion(raw) {
    const entries = Array.isArray(raw?.entries)
      ? raw.entries.filter((entry) => entry && typeof entry === "object").map(normalizeEntry)
      : [];
    return {
      id: typeof raw?.id === "string" && raw.id ? raw.id : createId(),
      saved: raw?.saved === true,
      title: mergeTitle(
        typeof raw?.title === "string" ? raw.title : "",
        typeof raw?.description === "string" ? raw.description : "",
      ),
      createdAt: validIso(raw?.createdAt) ? raw.createdAt : "",
      updatedAt: validIso(raw?.updatedAt) ? raw.updatedAt : "",
      entries,
    };
  }

  function normalizeDeleted(list) {
    if (!Array.isArray(list)) return [];
    const map = new Map();
    for (const item of list) {
      if (!item || typeof item.id !== "string" || !item.id) continue;
      const deletedAt = validIso(item.deletedAt) ? item.deletedAt : "";
      const prev = map.get(item.id);
      if (!prev || timestampMs(deletedAt) >= timestampMs(prev.deletedAt)) {
        map.set(item.id, { id: item.id, deletedAt });
      }
    }
    return [...map.values()];
  }

  function blocked(version, deleted) {
    const tombstone = deleted.find((item) => item.id === version.id);
    if (!tombstone) return false;
    return timestampMs(tombstone.deletedAt) >= timestampMs(version.updatedAt);
  }

  function normalizeState(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    let versions = [];
    let activeId = null;
    let deleted = [];
    let updatedAt = "";

    if (Array.isArray(parsed.versions)) {
      versions = parsed.versions.filter((version) => version && typeof version === "object").map(normalizeVersion);
      activeId = typeof parsed.activeId === "string" && parsed.activeId ? parsed.activeId : null;
      deleted = normalizeDeleted(parsed.deleted);
      updatedAt = validIso(parsed.updatedAt) ? parsed.updatedAt : "";
    } else if (
      "entries" in parsed ||
      "title" in parsed ||
      "saved" in parsed ||
      parsed.open === true ||
      "description" in parsed
    ) {
      const version = normalizeVersion(parsed);
      const keep = version.saved || parsed.open === true || versionHasContent(version);
      versions = keep ? [version] : [];
      activeId = parsed.open === true && versions[0] ? versions[0].id : null;
    } else {
      return null;
    }

    versions = versions.filter((version) => !blocked(version, deleted));
    if (activeId && !versions.some((version) => version.id === activeId)) activeId = null;

    return { activeId, versions, deleted, updatedAt };
  }

  function mergeDeleted(localDeleted, remoteDeleted) {
    return normalizeDeleted([...(remoteDeleted || []), ...(localDeleted || [])]);
  }

  function mergeVersions(localVersions, remoteVersions, deleted) {
    const map = new Map();
    for (const version of remoteVersions || []) {
      if (!version || typeof version.id !== "string" || !version.id) continue;
      if (blocked(version, deleted)) continue;
      map.set(version.id, version);
    }
    for (const version of localVersions || []) {
      if (!version || typeof version.id !== "string" || !version.id) continue;
      if (blocked(version, deleted)) continue;
      const existing = map.get(version.id);
      if (!existing || timestampMs(version.updatedAt) > timestampMs(existing.updatedAt)) {
        map.set(version.id, version);
      }
    }
    return [...map.values()].sort((a, b) => {
      const delta = timestampMs(a.createdAt) - timestampMs(b.createdAt);
      if (delta) return delta;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

  function canonical(state) {
    return {
      activeId: state.activeId || null,
      versions: (state.versions || []).map((version) => ({
        id: version.id,
        saved: version.saved === true,
        title: version.title || "",
        createdAt: version.createdAt || "",
        updatedAt: version.updatedAt || "",
        entries: (version.entries || []).map((entry) => ({
          id: entry.id,
          name: entry.name || "",
          content: entry.content || "",
          comment: entry.comment || "",
        })),
      })),
      deleted: [...(state.deleted || [])]
        .map((item) => ({ id: item.id, deletedAt: item.deletedAt || "" }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
  }

  function signature(state) {
    return JSON.stringify(canonical(state));
  }

  function mergeStates(local, remote) {
    const deleted = mergeDeleted(local.deleted, remote.deleted);
    const versions = mergeVersions(local.versions, remote.versions, deleted);
    const localMs = timestampMs(local.updatedAt);
    const remoteMs = timestampMs(remote.updatedAt);
    let activeId = localMs > remoteMs ? local.activeId : remote.activeId;
    const fallback = localMs > remoteMs ? remote.activeId : local.activeId;
    if (!versions.some((version) => version.id === activeId)) {
      activeId = versions.some((version) => version.id === fallback) ? fallback : null;
    }

    let updatedMs = Math.max(localMs, remoteMs);
    for (const version of versions) updatedMs = Math.max(updatedMs, timestampMs(version.updatedAt));
    for (const item of deleted) updatedMs = Math.max(updatedMs, timestampMs(item.deletedAt));

    const merged = { activeId, versions, deleted, updatedAt: updatedMs ? new Date(updatedMs).toISOString() : "" };
    if (signature(merged) !== signature(remote) && updatedMs <= remoteMs) {
      merged.updatedAt = new Date().toISOString();
    }
    return merged;
  }

  return {
    normalizeState,
    mergeStates,
    signature,
    versionHasContent,
  };
});
