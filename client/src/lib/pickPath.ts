// Cross-platform file/folder picker that returns a REAL filesystem path.
//
// Desktop uses the native dialog (plugin-dialog), which already returns
// real paths. Android's scoped storage doesn't — its directory picker is
// a no-op and its file picker returns content:// URIs the engine can't
// read — so on Android we route to the in-app real-path browser
// (LocalPathPicker via the localPicker store) instead. Callers don't
// branch; they just `await pickPath({ mode })`.

import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { isAndroid } from "./platform";
import { pickLocalPath } from "../state/localPicker";

export interface PickPathOptions {
  mode: "file" | "folder";
  title?: string;
  /** Desktop file-dialog filters (ignored by the Android browser). */
  filters?: { name: string; extensions: string[] }[];
}

/** Pick a single real path, or null if cancelled. */
export async function pickPath(opts: PickPathOptions): Promise<string | null> {
  if (isAndroid()) {
    return pickLocalPath({ mode: opts.mode, title: opts.title });
  }
  const sel = await openDialog({
    directory: opts.mode === "folder",
    multiple: false,
    title: opts.title,
    filters: opts.filters,
  });
  return typeof sel === "string" ? sel : null;
}

/**
 * Pick one OR MORE real file paths (desktop multi-select). Lets a user
 * build a list in one gesture — e.g. select several payloads to seed a
 * playlist. Android's in-app browser is single-select, so it yields at
 * most one path (drag-drop, the other multi-add route, is desktop-only
 * too). Returns [] if cancelled. Files only — multi-folder select isn't
 * a use case here.
 */
export async function pickPaths(
  opts: Omit<PickPathOptions, "mode"> = {},
): Promise<string[]> {
  if (isAndroid()) {
    const one = await pickLocalPath({ mode: "file", title: opts.title });
    return typeof one === "string" ? [one] : [];
  }
  const sel = await openDialog({
    directory: false,
    multiple: true,
    title: opts.title,
    filters: opts.filters,
  });
  if (Array.isArray(sel)) {
    return sel.filter((s): s is string => typeof s === "string");
  }
  return typeof sel === "string" ? [sel] : [];
}
