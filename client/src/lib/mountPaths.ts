// Helpers for reasoning about PS5 mount paths.
//
// Removable mounts (`/mnt/usb*`, `/mnt/ext*`) are special in two ways the
// app cares about: a drive can be unplugged out from under a browsed path
// (File System falls back to /data), and Sony's installer can't install a
// .pkg directly off an exfat USB mount (pkgLibrary stages it to internal
// storage first). Both used to inline the same regex; centralizing it keeps
// the "what counts as removable" rule in one tested place.

/** True if a console path lives on a removable USB / external drive. */
export function isRemovableMount(path: string): boolean {
  return /^\/mnt\/(usb|ext)/i.test(path);
}

/** The removable-drive mount root for a path
 *  (`/mnt/usb0/games/x.pkg` → `/mnt/usb0`), or null when the path isn't on
 *  a removable mount. */
export function removableMountRoot(path: string): string | null {
  return path.match(/^(\/mnt\/(?:usb|ext)[^/]*)/i)?.[1] ?? null;
}
