import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real api/ps5 (UploadJobError class, generateTxIdHex, etc.) and
// only override the network-touching functions so we can drive the runner
// deterministically without a PS5 or engine.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/ensurePayloadCurrent", () => ({
  ensurePayloadCurrent: vi.fn(async () => {}),
}));
vi.mock("../api/ps5", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/ps5")>();
  return {
    ...actual,
    uploadQueueLoad: vi.fn(async () => ({ items: [], continueOnFailure: false })),
    uploadQueueSave: vi.fn(async () => {}),
    startTransferFile: vi.fn(async () => "job"),
    startTransferDir: vi.fn(async () => "job"),
    startTransferDirReconcile: vi.fn(async () => "job"),
    startTransferZip: vi.fn(async () => "job"),
    jobStatus: vi.fn(async () => ({ status: "running" })),
    fsMount: vi.fn(),
  };
});

import { jobStatus, startTransferFile } from "../api/ps5";
import {
  useUploadQueueStore,
  distinctPendingHosts,
  nextPendingForHost,
  type QueueItem,
  type AddQueueItem,
} from "./uploadQueue";
import { useUploadSettingsStore } from "./uploadSettings";

const mockedJobStatus = vi.mocked(jobStatus);
const mockedStartFile = vi.mocked(startTransferFile);

function installLocalStorageStub() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  });
}

function addItem(addr: string, name: string): void {
  const input: AddQueueItem = {
    sourceKind: "file",
    sourcePath: `/src/${name}`,
    displayName: name,
    resolvedDest: `/data/${name}`,
    addr,
    strategy: "overwrite",
    reconcileMode: "fast",
    excludes: [],
    mountAfterUpload: false,
    mountReadOnly: false,
  };
  useUploadQueueStore.getState().add(input);
}

const itemsByStatus = (status: string) =>
  useUploadQueueStore.getState().items.filter((i) => i.status === status);

// ── Pure partition helpers ──────────────────────────────────────────────────

function qi(addr: string, status: QueueItem["status"]): QueueItem {
  return { id: addr + status, addr, status } as QueueItem;
}

describe("distinctPendingHosts", () => {
  it("returns pending hosts (port-stripped) in first-seen order, deduped", () => {
    const items = [
      qi("192.168.1.10:9113", "done"), // not pending → ignored
      qi("192.168.1.20:9113", "pending"),
      qi("192.168.1.10:9113", "pending"),
      qi("192.168.1.20:9114", "pending"), // same host, diff port → deduped
    ];
    expect(distinctPendingHosts(items)).toEqual(["192.168.1.20", "192.168.1.10"]);
  });

  it("is empty when nothing is pending", () => {
    expect(distinctPendingHosts([qi("a:9113", "done")])).toEqual([]);
  });
});

describe("nextPendingForHost", () => {
  it("returns the first pending item for the given host, ignoring others", () => {
    const items = [
      qi("10.0.0.1:9113", "running"),
      qi("10.0.0.2:9113", "pending"), // other host
      qi("10.0.0.1:9113", "pending"), // ← this one
    ];
    expect(nextPendingForHost(items, "10.0.0.1")?.id).toBe(
      "10.0.0.1:9113pending",
    );
    expect(nextPendingForHost(items, "10.0.0.9")).toBeNull();
  });
});

// ── Runner: serial vs per-console parallel ───────────────────────────────────

describe("upload runner concurrency", () => {
  beforeEach(() => {
    installLocalStorageStub();
    vi.useFakeTimers();
    mockedJobStatus.mockReset().mockResolvedValue({
      status: "running",
    } as Awaited<ReturnType<typeof jobStatus>>);
    mockedStartFile.mockReset().mockResolvedValue("job");
    useUploadQueueStore.setState({
      items: [],
      running: false,
      continueOnFailure: true,
      loaded: true,
    });
    useUploadSettingsStore.setState({ parallelConsoles: false });
  });
  afterEach(() => {
    useUploadQueueStore.getState().stop();
    vi.useRealTimers();
  });

  it("serial (default): only ONE item runs at a time across consoles", async () => {
    addItem("192.168.1.10:9113", "A1");
    addItem("192.168.1.20:9113", "B1");

    void useUploadQueueStore.getState().start();
    // Flush preflight + mark-running + the first jobStatus poll (which keeps
    // returning "running", so both items stay in-flight if they started).
    await vi.advanceTimersByTimeAsync(50);

    expect(itemsByStatus("running")).toHaveLength(1);
    expect(itemsByStatus("pending")).toHaveLength(1);
  });

  it("parallel: items on DIFFERENT consoles run concurrently", async () => {
    useUploadSettingsStore.setState({ parallelConsoles: true });
    addItem("192.168.1.10:9113", "A1");
    addItem("192.168.1.20:9113", "B1");

    void useUploadQueueStore.getState().start();
    await vi.advanceTimersByTimeAsync(50);

    // Both consoles' first item should be running at once.
    const running = itemsByStatus("running");
    expect(running).toHaveLength(2);
    const hosts = running.map((i) => i.addr).sort();
    expect(hosts).toEqual(["192.168.1.10:9113", "192.168.1.20:9113"]);
  });

  it("parallel: SAME console stays serial (its 2nd item waits)", async () => {
    useUploadSettingsStore.setState({ parallelConsoles: true });
    addItem("192.168.1.10:9113", "A1");
    addItem("192.168.1.10:9113", "A2"); // same console
    addItem("192.168.1.20:9113", "B1");

    void useUploadQueueStore.getState().start();
    await vi.advanceTimersByTimeAsync(50);

    const running = itemsByStatus("running");
    // One per console: A1 + B1 running, A2 pending behind A1.
    expect(running).toHaveLength(2);
    expect(running.map((i) => i.displayName).sort()).toEqual(["A1", "B1"]);
    expect(itemsByStatus("pending").map((i) => i.displayName)).toEqual(["A2"]);
  });

  it("parallel: both consoles drain to completion", async () => {
    useUploadSettingsStore.setState({ parallelConsoles: true });
    addItem("192.168.1.10:9113", "A1");
    addItem("192.168.1.20:9113", "B1");
    // Let every job report done on the first poll.
    mockedJobStatus.mockResolvedValue({
      status: "done",
      bytes_sent: 100,
      elapsed_ms: 10,
    } as Awaited<ReturnType<typeof jobStatus>>);

    const p = useUploadQueueStore.getState().start();
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(itemsByStatus("done")).toHaveLength(2);
    expect(useUploadQueueStore.getState().running).toBe(false);
  });
});
