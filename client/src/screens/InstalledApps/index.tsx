import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Gamepad2,
  RefreshCw,
  Trash2,
  Disc3,
  FolderOpen,
  Package,
  AlertTriangle,
} from "lucide-react";

import { useConnectionStore } from "../../state/connection";
import {
  appsInstalled,
  appUnregister,
  appIconUrl,
  type InstalledTitle,
} from "../../api/ps5";
import { PageHeader, EmptyState, ErrorCard, WarningCard, Button } from "../../components";
// Direct import to avoid the barrel's circular-dep warning at build.
import { useConfirm } from "../../components/ConfirmDialog";
import { humanizePs5Error } from "../../lib/humanizeError";
import { useTr } from "../../state/lang";
import { transferAddr } from "../../lib/addr";
import { useStaleHostGuard } from "../../lib/staleHostGuard";

/** Cover art for one installed title. Mirrors the Library screen's icon
 *  pattern: render the engine `<img>` (which streams the title's
 *  appmeta/icon0.png), and fall back to a sibling icon on 404 — the icon
 *  may genuinely be missing (common for system apps) so a graceful
 *  placeholder beats a broken-image glyph. */
function Cover({
  host,
  title,
}: {
  host: string;
  title: InstalledTitle;
}) {
  const [failed, setFailed] = useState(false);
  const show = !failed && !!host.trim();
  return (
    <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-[var(--color-surface-3)]">
      {show ? (
        <img
          src={appIconUrl(transferAddr(host), title.titleId)}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Gamepad2 size={28} className="text-[var(--color-muted)]" />
      )}
    </div>
  );
}

function OriginBadge({ title }: { title: InstalledTitle }) {
  const tr = useTr();
  if (title.system) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-[var(--color-danger-soft,#7f1d1d33)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-danger,#ef4444)]">
        <AlertTriangle size={11} />
        {tr("installed_badge_system", undefined, "System")}
      </span>
    );
  }
  if (title.origin === "registered") {
    return title.imageBacked ? (
      <span className="inline-flex items-center gap-1 rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted)]">
        <Disc3 size={11} />
        {tr("installed_badge_image", undefined, "Disc image")}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted)]">
        <FolderOpen size={11} />
        {tr("installed_badge_folder", undefined, "Folder")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted)]">
      <Package size={11} />
      {tr("installed_badge_pkg", undefined, "Package")}
    </span>
  );
}

function AppCard({
  host,
  title,
  busy,
  onUninstall,
}: {
  host: string;
  title: InstalledTitle;
  busy: boolean;
  onUninstall: (t: InstalledTitle) => void;
}) {
  const tr = useTr();
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <Cover host={host} title={title} />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={title.titleName}>
          {title.titleName}
        </div>
        <div className="truncate font-mono text-[11px] text-[var(--color-muted)]">
          {title.titleId}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <OriginBadge title={title} />
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() => onUninstall(title)}
          title={tr("installed_uninstall", undefined, "Uninstall")}
        >
          <Trash2 size={14} />
          {busy
            ? tr("installed_uninstalling", undefined, "Removing…")
            : tr("installed_uninstall", undefined, "Uninstall")}
        </Button>
      </div>
      {title.origin === "registered" && title.source ? (
        <div
          className="truncate text-[10px] text-[var(--color-muted)]"
          title={title.source}
        >
          {title.source}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
  count,
}: {
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">
          {title} <span className="text-[var(--color-muted)]">({count})</span>
        </h2>
        <p className="text-xs text-[var(--color-muted)]">{hint}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {children}
      </div>
    </section>
  );
}

export default function InstalledAppsScreen() {
  const tr = useTr();
  const host = useConnectionStore((s) => s.host);
  const guard = useStaleHostGuard();
  const [titles, setTitles] = useState<InstalledTitle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registeredUnavailable, setRegisteredUnavailable] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Native window.confirm() is a no-op in Tauri's webview; use the in-tree
  // modal instead (see ConfirmDialog.tsx).
  const { confirm: confirmDialog, dialog: confirmDialogNode } = useConfirm();

  const refresh = useCallback(async () => {
    if (!host?.trim()) return;
    const probe = guard.capture();
    setLoading(true);
    setError(null);
    try {
      const res = await appsInstalled(transferAddr(probe.host));
      if (probe.isStale()) return;
      setTitles(res.titles);
      setRegisteredUnavailable(res.registeredUnavailable);
    } catch (e) {
      if (probe.isStale()) return;
      const raw = e instanceof Error ? e.message : String(e);
      setError(humanizePs5Error(raw));
      setTitles(null);
    } finally {
      setLoading(false);
    }
  }, [host, guard]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUninstall = useCallback(
    async (t: InstalledTitle) => {
      if (!host?.trim()) return;
      // Capture the target console BEFORE the (possibly long-lived) confirm
      // dialog so switching the active PS5 mid-dialog can't fire the
      // uninstall against the wrong console.
      const probe = guard.capture();
      const ok = await confirmDialog({
        title: tr(
          "installed_uninstall_confirm_title",
          { name: t.titleName },
          `Uninstall ${t.titleName}?`,
        ),
        message: t.system
          ? tr(
              "installed_uninstall_confirm_system",
              { id: t.titleId },
              `${t.titleId} is a SYSTEM app. Removing it can destabilize the console and may require a reinstall to recover. Only continue if you know exactly what this package is.`,
            )
          : t.origin === "registered"
            ? tr(
                "installed_uninstall_confirm_registered",
                undefined,
                "This unmounts and removes the title from the home screen. Your source files/image on disk are not deleted.",
              )
            : tr(
                "installed_uninstall_confirm_pkg",
                undefined,
                "This removes the installed title from the PS5. You can reinstall it later from the package.",
              ),
        confirmLabel: tr("installed_uninstall", undefined, "Uninstall"),
        destructive: true,
      });
      if (!ok || probe.isStale()) return;
      setBusyId(t.titleId);
      setError(null);
      try {
        await appUnregister(transferAddr(probe.host), t.titleId);
        if (probe.isStale()) return;
        // Optimistic remove, then re-sync from the console.
        setTitles((cur) => cur?.filter((x) => x.titleId !== t.titleId) ?? cur);
        void refresh();
      } catch (e) {
        if (probe.isStale()) return;
        const raw = e instanceof Error ? e.message : String(e);
        setError(humanizePs5Error(raw));
      } finally {
        setBusyId(null);
      }
    },
    [host, guard, confirmDialog, tr, refresh],
  );

  const pkg = useMemo(
    () => (titles ?? []).filter((t) => t.origin === "pkg"),
    [titles],
  );
  const registered = useMemo(
    () => (titles ?? []).filter((t) => t.origin === "registered"),
    [titles],
  );

  return (
    <div className="flex flex-col gap-5 p-5">
      <PageHeader
        icon={Gamepad2}
        title={tr("installed_apps_title", undefined, "Installed Apps")}
        loading={loading}
        description={tr(
          "installed_apps_subtitle",
          undefined,
          "Everything installed on the PS5, grouped by how it got there. Uninstall removes a title (and, for mounted titles, unmounts it).",
        )}
        right={
          <Button
            variant="secondary"
            onClick={() => void refresh()}
            disabled={loading || !host?.trim()}
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            {tr("refresh", undefined, "Refresh")}
          </Button>
        }
      />

      {!host?.trim() ? (
        <EmptyState
          icon={Gamepad2}
          size="hero"
          title={tr("installed_no_host_title", undefined, "Not connected")}
          message={tr(
            "installed_no_host_body",
            undefined,
            "Connect to a PS5 on the Connection tab to see installed apps.",
          )}
        />
      ) : error ? (
        <ErrorCard
          title={tr("installed_error_title", undefined, "Couldn't read installed apps")}
          detail={error}
        />
      ) : loading && titles === null ? (
        <EmptyState
          icon={RefreshCw}
          title={tr("installed_loading", undefined, "Reading installed titles…")}
          message={tr(
            "installed_loading_hint",
            undefined,
            "Enumerating /user/appmeta on the PS5.",
          )}
        />
      ) : titles && titles.length === 0 ? (
        <EmptyState
          icon={Gamepad2}
          size="hero"
          title={tr("installed_empty_title", undefined, "No installed titles found")}
          message={tr(
            "installed_empty_body",
            undefined,
            "Nothing under /user/appmeta. Install a package or register a game first.",
          )}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {registeredUnavailable ? (
            <WarningCard
              title={tr(
                "installed_registered_unavailable",
                undefined,
                "Couldn't read the mounted/registered set from the payload — everything is shown under Installed from package. Reload the payload to fix grouping.",
              )}
            />
          ) : null}

          {pkg.length > 0 ? (
            <Section
              title={tr(
                "installed_section_pkg",
                undefined,
                "Installed from package",
              )}
              hint={tr(
                "installed_section_pkg_hint",
                undefined,
                "Installed via Sony's installer from a .pkg (or shipped with the console).",
              )}
              count={pkg.length}
            >
              {pkg.map((t) => (
                <AppCard
                  key={t.titleId}
                  host={host}
                  title={t}
                  busy={busyId === t.titleId}
                  onUninstall={handleUninstall}
                />
              ))}
            </Section>
          ) : null}

          {registered.length > 0 ? (
            <Section
              title={tr(
                "installed_section_registered",
                undefined,
                "Mounted & registered by PS5Upload",
              )}
              hint={tr(
                "installed_section_registered_hint",
                undefined,
                "Registered from a game folder, .exfat/.ffpkg disc image, or upload. Uninstalling unmounts them; your source files are kept.",
              )}
              count={registered.length}
            >
              {registered.map((t) => (
                <AppCard
                  key={t.titleId}
                  host={host}
                  title={t}
                  busy={busyId === t.titleId}
                  onUninstall={handleUninstall}
                />
              ))}
            </Section>
          ) : null}
        </div>
      )}

      {confirmDialogNode}
    </div>
  );
}
