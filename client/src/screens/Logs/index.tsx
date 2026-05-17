import { ScrollText, Terminal } from "lucide-react";

import TabbedShell, { type TabbedShellTab } from "../../layout/TabbedShell";
import { useTr } from "../../state/lang";
import AppLogsPanel from "./AppLogsPanel";
import KernelLogPanel from "./KernelLogPanel";

/**
 * Logs screen — two URL-routed tabs:
 *
 *   - **app**: in-memory React/Tauri events. Persists for the session.
 *   - **kernel**: live /dev/klog stream from the helper. Polled.
 *
 * Pre-2.12.0 these were two separate sidebar entries (/logs and
 * /kernel-log). Merged with `?tab=kernel` so deep links work.
 *
 * The shell (URL contract + tablist + a11y + keyboard nav + page
 * header) lives in `layout/TabbedShell`; this file is just tab
 * metadata and a panel switch.
 */

type TabId = "app" | "kernel";

export default function LogsScreen() {
  const tr = useTr();
  const tabs: ReadonlyArray<TabbedShellTab<TabId>> = [
    {
      id: "app",
      icon: ScrollText,
      key: "logs_tab_app",
      fallback: "App",
      description: tr(
        "logs_description_app",
        undefined,
        "In-app log of errors, warnings, and notable events on the desktop side. Useful for bug reports — click Copy to grab a plain-text dump.",
      ),
    },
    {
      id: "kernel",
      icon: Terminal,
      key: "logs_tab_kernel",
      fallback: "Kernel",
      description: tr(
        "logs_description_kernel",
        undefined,
        "Live stream of /dev/klog from the payload. Open Filters to hide Sony's routine subsystem chatter while hunting a specific issue.",
      ),
    },
  ];

  return (
    <TabbedShell
      idPrefix="logs"
      titleIcon={null}
      titleKey="logs"
      titleFallback="Logs"
      tabs={tabs}
      renderPanel={(id) => (id === "kernel" ? <KernelLogPanel /> : <AppLogsPanel />)}
    />
  );
}
