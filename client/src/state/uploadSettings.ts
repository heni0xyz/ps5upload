import { create } from "zustand";
import type { ReconcileMode } from "../api/ps5";

/**
 * User preferences that govern the upload flow's defaults — what to do
 * when a destination already has content, and how strict the reconcile
 * should be when the user chooses "Resume".
 *
 * Persisted to localStorage so the settings survive restarts. Keyed on
 * a single namespace per concern — if the schema evolves, bump the key
 * (never silently migrate, the cost is one re-pick from the user).
 */

const KEY_ALWAYS_OVERWRITE = "ps5upload.always_overwrite";
const KEY_SHOW_FILES = "ps5upload.show_transfer_files";
const KEY_BANDWIDTH_CAP = "ps5upload.bandwidth_cap_mbps";
const KEY_UPLOAD_STREAMS = "ps5upload.upload_streams";

/** Upper bound on the user-selectable stream count, mirroring the engine's
 *  MAX_TRANSFER_STREAMS. The effective count is further clamped to whatever
 *  the connected payload advertises. */
export const MAX_UPLOAD_STREAMS = 4;

function loadAlwaysOverwrite(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(KEY_ALWAYS_OVERWRITE) === "true";
}

function loadReconcileMode(): ReconcileMode {
  // Safe mode was removed -- it hashed every remote file via BLAKE3
  // which took hours on large libraries and could destabilize the
  // payload. Per-shard BLAKE3 verification during actual upload
  // already catches mismatches, so size-only is a safe shortcut.
  // Ignore any stale "safe" in localStorage and always return "fast".
  return "fast";
}

function loadShowFiles(): boolean {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(KEY_SHOW_FILES);
  // Default ON — most users want to see what's happening.
  return v === null ? true : v === "true";
}

function loadBandwidthCap(): number {
  if (typeof window === "undefined") return 0;
  const v = window.localStorage.getItem(KEY_BANDWIDTH_CAP);
  if (!v) return 0;
  const n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : 0;
}

function loadUploadStreams(): number {
  // Default 4 (hardware-validated 2026-06-02: ~1.7× on Fat, ~1.4× on Pro).
  // Safe against older payloads — the effective count is min(setting, the
  // payload's advertised max_transfer_streams), and a payload that predates
  // multi-stream advertises nothing → clamps to 1 (single stream).
  if (typeof window === "undefined") return MAX_UPLOAD_STREAMS;
  const v = window.localStorage.getItem(KEY_UPLOAD_STREAMS);
  if (!v) return MAX_UPLOAD_STREAMS;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return MAX_UPLOAD_STREAMS;
  return Math.min(Math.max(n, 1), MAX_UPLOAD_STREAMS);
}

interface UploadSettingsState {
  /** When true, the Upload flow skips the Override/Resume/Cancel
   *  dialog and always overwrites the destination. Useful for
   *  iterating on dev builds. */
  alwaysOverwrite: boolean;
  /** Default mode for "Resume": Fast (size-only) or Safe (hash). */
  reconcileMode: ReconcileMode;
  /** When true, the Upload screen renders the per-file scroll panel
   *  during a transfer. Off hides the panel (keeps the progress bar +
   *  summary counters). Useful on low-end displays or when the list
   *  feels noisy for folders with thousands of files. */
  showTransferFiles: boolean;
  /** Outbound bandwidth cap in MB/s. 0 = no cap (use the engine's
   *  env-var default, also typically 0). Persisted to localStorage. */
  bandwidthCapMbps: number;
  /** Desired parallel upload streams (1 = single stream = default/off).
   *  The effective count is min(this, the payload's advertised
   *  max_transfer_streams), resolved at upload start. Breaks the
   *  single-stream ~40 MB/s write ceiling on non-Pro PS5s. */
  uploadStreams: number;
  setAlwaysOverwrite: (on: boolean) => void;
  setShowTransferFiles: (on: boolean) => void;
  setBandwidthCapMbps: (n: number) => void;
  setUploadStreams: (n: number) => void;
}

export const useUploadSettingsStore = create<UploadSettingsState>((set) => ({
  alwaysOverwrite: loadAlwaysOverwrite(),
  reconcileMode: loadReconcileMode(),
  showTransferFiles: loadShowFiles(),
  bandwidthCapMbps: loadBandwidthCap(),
  uploadStreams: loadUploadStreams(),
  setAlwaysOverwrite: (alwaysOverwrite) => {
    window.localStorage.setItem(
      KEY_ALWAYS_OVERWRITE,
      alwaysOverwrite ? "true" : "false",
    );
    set({ alwaysOverwrite });
  },
  setShowTransferFiles: (showTransferFiles) => {
    window.localStorage.setItem(
      KEY_SHOW_FILES,
      showTransferFiles ? "true" : "false",
    );
    set({ showTransferFiles });
  },
  setBandwidthCapMbps: (bandwidthCapMbps) => {
    if (bandwidthCapMbps > 0) {
      window.localStorage.setItem(
        KEY_BANDWIDTH_CAP,
        bandwidthCapMbps.toString(),
      );
    } else {
      window.localStorage.removeItem(KEY_BANDWIDTH_CAP);
    }
    set({ bandwidthCapMbps });
  },
  setUploadStreams: (n) => {
    const clamped = Math.min(Math.max(Math.round(n), 1), MAX_UPLOAD_STREAMS);
    window.localStorage.setItem(KEY_UPLOAD_STREAMS, clamped.toString());
    set({ uploadStreams: clamped });
  },
}));
