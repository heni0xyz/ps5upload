# ps5upload v4.x+ — Feature Gap Analysis

Cross-reference of elf-arsenal capabilities vs. ps5upload's current
feature set, with design proposals for each missing feature.

> **v4.0 shipped status (2026-07):** Of the features scaffolded against
> this roadmap, only the ones with complete, working payload logic were
> kept: **Remote Play PIN (P0-1)**, **Fan Curve Editor (P0-3)**,
> **Persistent Notifications (P0-4)**, and **Backup/restore snapshots**.
> The remaining scaffolds — Save Resign, Activity Tracker, Cheats, SDK
> Changer, FTP, TMDB, SMB, FW Spoof, Linux Loader, Plugin Loader,
> fpkg-guard, and Garlic — were **removed** because their payload side was
> a stub (returned `"not implemented"`) and/or they were SKIP-listed
> below as risky/out-of-scope. Their FTX2 frame numbers are left
> unallocated (not reused). The design write-ups below remain the plan of
> record for finishing them properly in a later release.

**Methodology:** Every elf-arsenal source module (~40 files, 130+
endpoints, 20+ embedded payloads) was cataloged. Features ps5upload
already has were eliminated. The remaining gaps are prioritized by
user value, implementation complexity, and architectural fit with
ps5upload's FTX2 protocol (payload → engine → Tauri → React).

---

## Priority Legend

| Priority | Meaning |
|----------|---------|
| P0 | High user value, fits existing architecture, low-medium effort |
| P1 | High value but complex, or medium value + medium effort |
| P2 | Niche / advanced, lower priority for v4.x |
| SKIP | Already implemented or not applicable |

---

## Already in ps5upload (SKIP)

These elf-arsenal features already exist in ps5upload (often more
polished):

- File transfer (upload/download/copy/move/delete/mkdir/chmod/rename)
- File system browser + search (client + payload-side index)
- Hardware sensors (CPU/SoC temp, fan, power, storage)
- Drive SMART/temp sensors (SCSI LOG SENSE)
- Fan threshold control (permanent pinning)
- Profile management (users, offline-account slots, username rename)
- User create/delete
- Avatar customization
- Backup & restore (tag-based snapshots)
- nanoDNS
- Process list + kill
- System power control (reboot/shutdown/standby)
- Kernel log viewer
- Payload delivery (ELF send, catalog, playlists, USB autoloader)
- PKG install (regular + DPI)
- App launch/lifecycle/suspend/resume/kill
- Mount/unmount (exfat/ffpkg/ffpfs)
- Library / installed apps / app.db query
- Screenshots + videos (list/convert/download)
- Save data management (list, zip backup, restore)
- Volumes / disk usage
- Companions detection
- Multi-PS5 roster
- Notification inbox (client-side)
- Shell command execution
- System clock get/sync
- SDK version / FW requirement display (from param.json)
- SMP awareness (read-only detection)
- mDNS discovery
- Game metadata / cover art

---

## Gap Features

### P0-1: Remote Play PIN Generator

**elf-arsenal source:** `src/remoteplay.c` (340 lines)

**What it does:** Generates a Remote Play PIN code and account ID so
users can pair Chiaki/pxplay without navigating the PS5's hidden
Remote Play settings. Uses ptrace-free function injection — loads
`libSceRemoteplay.sprx` into the payload's own process, calls
`sceRemoteplayGeneratePinCode`, then polls
`sceRemotePlayConfirmDeviceRegist` for pairing success/failure.

**Why it's valuable:** One of the most-requested scene features. The
PS5's built-in Remote Play enable path is buried in Settings →
System → Remote Play, and still requires manual PIN entry. This
generates the PIN programmatically and shows the account ID needed
for Chiachi/pxplay pairing — all from ps5upload's UI.

**Sony APIs used:**
- `sceKernelLoadStartModule("/system/common/lib/libSceRemoteplay.sprx")`
- `kernel_dynlib_handle` + `kernel_dynlib_dlsym` (resolve symbols)
- `sceRemoteplayGeneratePinCode(uint32_t *pin)`
- `sceRemotePlayConfirmDeviceRegist(uint32_t *status, uint32_t *err)`
- `sceRemoteplayInitialize(int slot, void *param)`
- `sceRemoteplayNotifyPinCodeError(void)`
- `sceRegMgrGetInt` / `sceRegMgrSetInt` / `sceRegMgrGetBin`
- `sceUserServiceGetForegroundUser`
- `kill(pid, SIGKILL)` on SceRemotePlay daemon (reset stale session)

**FTX2 Frame Types:** 188–191
```
RemotePlayRequest  = 188   // req: {"manual_account_id":"..."} or {}
RemotePlayStatus   = 189   // ack: {"state":"idle|starting|waiting|paired|failed|timeout","pin":"XXXX XXXX","account_id":"base64","seconds_left":N}
RemotePlayCancel   = 190   // req: {}
RemotePlayCancelAck= 191   // ack: {"ok":true}
```

**Payload:** `remoteplay.c` — port from elf-arsenal, adapt to FTX2
dispatch + `send_frame` pattern. State machine (IDLE → RUNNING →
WAITING → PAIRED/FAILED/TIMEOUT) runs in a detached pthread, status
queried via `RemotePlayStatus`. Kill SceRemotePlay daemon before
generating PIN to clear stale sessions.

**Engine:** `remoteplay.rs` — `remoteplay_request(addr, account_id?)`,
`remoteplay_status(addr)`, `remoteplay_cancel(addr)`. Routes:
- `POST /api/ps5/remoteplay/request`
- `GET /api/ps5/remoteplay/status`
- `POST /api/ps5/remoteplay/cancel`

**Client:** New "Remote Play" card on the Connection or System
screen. Shows PIN + countdown timer + account ID (copyable). Status
polls every 2s. Cancel button.

**Complexity:** Medium. The Sony API resolution via `kernel_dynlib_*`
is already used in the payload for other features. The state machine
+ background thread pattern is well-understood from the reference.

---

### P0-2: Game Activity Tracker (Play Time + Launch Count)

**elf-arsenal source:** `src/activity.c` (342 lines) +
`src/activitydb.c` (562 lines)

**What it does:** Tracks per-title launch count and total play time.
Two data sources:
1. **Self-tracked** (`activity.c`) — payload monitors running titles
   via `sceSystemServiceGetAppIdOfRunningBigApp` + process list,
   records launch events + session duration to a JSON file
2. **System DB** (`activitydb.c`) — queries Sony's own
   `sl2_log.db` (system logger) and `app.db` for historical play time,
   recently-played icons, avatar history

**Why it's valuable:** Sony tracks this on-console but doesn't expose
it to users in a useful way. A "Stats" or "Activity" screen showing
"you've played Elden Ring for 340 hours across 89 sessions" is
high-impact, low-complexity.

**Sony APIs used:**
- `sceSystemServiceGetAppIdOfRunningBigApp` — detect foreground game
- Process list enumeration (already in ps5upload's payload)
- SQLite3 read of `/system_data/priv/system_logger2/nobackup/database/sl2_log.db`
- SQLite3 read of `/system_data/priv/mms/app.db` (already queried)

**FTX2 Frame Types:** 192–195
```
ActivityGet        = 192   // req: {}
ActivityGetAck     = 193   // ack: {"titles":[{"title_id":"CUSA...","launches":N,"total_seconds":N,"last_played":N}],...}
ActivityDbQuery    = 194   // req: {"query":"recently_played|play_time|avatar_log"}
ActivityDbQueryAck = 195   // ack: {"rows":[...]}
```

**Payload:** `activity.c` — periodic poll thread (every 30s) that
detects foreground title transitions, increments counters, persists
to `/data/ps5upload/activity.json`. `activitydb.c` — sqlite3 queries
against sl2_log.db for historical data.

**Engine:** `activity.rs` — `activity_get(addr)`, `activity_db_query(addr, query)`.
Routes:
- `GET /api/ps5/activity`
- `GET /api/ps5/activity/db?query=recently_played`

**Client:** Extend existing Stats screen or add "Play Time" tab to
Dashboard. Per-game play time breakdown, total hours, session history
graph.

**Complexity:** Medium. SQLite is already linked into the payload (used
by app.db queries). The sl2_log.db schema is stable across firmware
versions. Self-tracking is a simple background poll thread.

---

### P0-3: Fan Curve Editor

**elf-arsenal source:** `src/fan.c` (~200 lines)

**What it does:** Beyond ps5upload's single-threshold fan pinning,
elf-arsenal implements a full **fan curve** — multiple
temperature/percentage points that define a continuous duty cycle.
ICC fan threshold set via `/dev/icc_fan` ioctl `0xC01C8F07`.

**Why it's valuable:** Single-threshold pinning (what ps5upload has)
is a blunt instrument — the fan jumps to a fixed speed at one
temperature. A curve gives smoother transitions: e.g. 30% at 50°C,
50% at 65°C, 80% at 75°C, 100% at 85°C. Power users want this.

**Sony APIs used:**
- `/dev/icc_fan` ioctl `0xC01C8F07` (already used for threshold pin)
- Same ICC register write mechanism

**FTX2 Frame Types:** 196–197
```
HwFanCurveSet      = 196   // req: {"points":[{"temp_c":N,"duty_pct":N},...]}
HwFanCurveSetAck   = 197   // ack: {"ok":true}
```
(Reading the current curve reuses the existing `HwTemps` frame, which
can be extended to include `fan_curve` in the JSON.)

**Payload:** Extend `hw_info.c` — store curve points, reapply every
15s in the fan-pinning loop (same mechanism as single threshold, but
interpolate duty from curve points instead of a flat value).

**Engine:** Extend `hw.rs` — `set_fan_curve(addr, points: Vec<FanCurvePoint>)`.
Route: `POST /api/ps5/hw/fan-curve`.

**Client:** Extend `FanThresholdCard` on Hardware screen. Toggle
between "Fixed threshold" (current) and "Fan curve" mode. Curve
editor: visual point editor or list of temp/duty pairs with a small
SVG preview graph.

**Complexity:** Low-medium. The ICC mechanism is the same as current
threshold pinning — just interpolate from a curve instead of a flat
value. Payload-side curve interpolation is ~30 lines of C.

---

### P0-4: Persistent On-PS5 Notification System

**elf-arsenal source:** `src/notif_inbox.c` (~200 lines)

**What it does:** A persistent notification store on the PS5 (64-entry
ring buffer) that survives payload restarts. The payload can push
notifications (e.g., "Backup completed", "Fan threshold reached") and
the client can read/clear them. ps5upload has a client-side
notification inbox, but it's lost on app restart and can't receive
payload-side events.

**Why it's valuable:** Payload-side events (backup completed, fan
triggered, drive error, save resigned) are invisible when they happen
while the user isn't looking at the app. A persistent on-PS5 store
means the next client connection surfaces everything that happened.

**Sony APIs used:** None — pure file I/O to
`/data/ps5upload/notifications.json` with a sequence counter.

**FTX2 Frame Types:** 198–199
```
NotifList          = 198   // req: {"since_seq":N}
NotifListAck       = 199   // ack: {"notifications":[{"seq":N,"ts":N,"msg":"..","level":"info|warn|error","read":bool}],...}
```
(Push is internal-only — the payload writes notifications to the file
and the client polls via this frame. No need for a push frame since
the client already polls `STATUS` periodically.)

**Payload:** `notif_store.c` — append-only JSON ring buffer at
`/data/ps5upload/notifications.json`. `notif_push(level, msg)` called
from backup handlers, fan threshold, drive error paths, etc.

**Engine:** `notifications.rs` — `notifications_list(addr, since_seq)`.
Route: `GET /api/ps5/notifications?since_seq=N`.

**Client:** Extend existing notification inbox to merge payload-side
notifications (fetched on connect + periodic poll). Badge count
includes unread payload notifications.

**Complexity:** Low. ~100 lines payload, ~50 lines engine, ~100 lines
client merge logic. No Sony APIs, no new dependencies.

---

### P1-1: Cheat Engine (Memory Patches)

**elf-arsenal source:** `src/cheats.c` (2822 lines), `src/xml_patches.c`

**What it does:** Native PS5 cheat engine supporting JSON, SHN
(GoldHEN/Shark), and MC4 (ps5cheats) formats. Applies memory patches
to running games via ptrace. Downloads cheat databases from
ps5cheats/GoldHEN/HENCollection repos. XML patch system for
CheatRunner-compatible patches.

**Why it's valuable:** Cheats are one of the top reasons users install
scene tools. A native cheat engine in ps5upload (vs. a separate
CheatRunner payload) is a major differentiator.

**Sony APIs used:**
- `ptrace(PT_ATTACH, ...)` — attach to running game process
- `ptrace(PT_READ_D/PT_WRITE_D)` — read/write process memory
- `sceSystemServiceGetAppIdOfRunningBigApp` — find target process
- `proc_info_t` + `kinfo_getprocess` — process enumeration (already used)

**FTX2 Frame Types:** 200–207
```
CheatList          = 200   // req: {"title_id":"CUSA..."}
CheatListAck       = 201   // ack: {"cheats":[...]}
CheatApply         = 202   // req: {"title_id":"..","cheat_id":"..","enabled":bool}
CheatApplyAck      = 203   // ack: {"ok":bool,"err":".."}
CheatRepoDownload  = 204   // req: {"repo":"ps5cheats|goldhen|hencollection"}
CheatRepoDownloadAck=205   // ack: {"ok":bool,"count":N}
XmlPatchList       = 206   // req: {}
XmlPatchListAck    = 207   // ack: {"patches":[...]}
```

**Payload:** `cheats.c` — port the core patch-application logic
(ptrace memory write). Cheat file parsing (JSON/SHN/MC4) can stay
payload-side (no point shipping format parsers in the engine).
Cheat repo download via `sceHttp*` (serialized with `sony_api_lock`).

**Engine:** `cheats.rs` — proxy functions. Routes under
`/api/ps5/cheats/*`.

**Client:** New "Cheats" screen. Lists installed cheat files per
title, toggle individual cheats on/off, download from repos. Shows
currently running game's cheats automatically.

**Complexity:** HIGH. 2800+ lines of C to port. Ptrace on PS5
requires `CHEAT_FW_PTRACE_REQ = 0x840u` capability. Format parsing
(SHN/MC4) is complex. Cheat repo download needs HTTP on the payload
side (already available via `sceHttp*`). This is a v5.0 feature, not
v4.x.

---

### P1-2: SDK Version Changer

**elf-arsenal source:** `src/sdk_changer.c` (490 lines)

**What it does:** Patches the SDK version in a game's `param.sfo` /
`param.json` to make games built against a newer SDK run on older
firmware. Scans installed titles, reads their SDK version, offers to
patch them down.

**Why it's valuable:** Users on older firmware (e.g., 4.03, 5.05) who
want to play games that require FW 7.x+ can use this to bypass the
version check. High-value for users staying on exploitable firmware.

**Sony APIs used:** None — pure file I/O. Reads/writes `param.sfo`
and `param.json` in `/user/appmeta/<title_id>/`.

**FTX2 Frame Types:** 208–211
```
SdkVersionScan     = 208   // req: {}
SdkVersionScanAck  = 209   // ack: {"titles":[{"title_id":"..","sdk_version":"0x..","fw_required":"..","path":".."}]}
SdkVersionPatch    = 210   // req: {"title_id":"..","target_sdk":"0x.."}
SdkVersionPatchAck = 211   // ack: {"ok":bool,"err":".."}
```

**Payload:** `sdk_changer.c` — scan `/user/app/` for title folders,
read `app.db` for title list, read `param.sfo` / `sce_sys/param.sfo`
for SDK version, patch the 8-byte version field. Create backup of
original param.sfo before patching.

**Engine:** `sdk_changer.rs` — `sdk_scan(addr)`, `sdk_patch(addr, title_id, target)`.
Routes:
- `GET /api/ps5/sdk/scan`
- `POST /api/ps5/sdk/patch`

**Client:** New "SDK Changer" screen (or sub-tab of Library/Installed
Apps). Shows table: title, current SDK version, FW required, patch
button. Warning dialog before patching.

**Complexity:** Medium. No Sony APIs — pure file manipulation.
param.sfo parsing already exists in the payload (used by folder
inspection). The main work is the scan + patch UI.

---

### P1-3: FTP Server

**elf-arsenal source:** `payloads/ftpsrv.elf`, `ftpsrv-src/`

**What it does:** Full FTP server running on the PS5. Clients can
connect with any FTP client (FileZilla, etc.) to browse/transfer
files. Supports SELF decryption, SHA256 verification.

**Why it's valuable:** FTP is the universal file transfer protocol —
many users prefer FileZilla over a custom UI for bulk file
management. ps5upload's FTX2 protocol is faster and more capable, but
FTP compatibility is expected by the scene.

**Implementation approach:** Don't port ftpsrv (it's a separate
payload). Instead, have ps5upload's payload **start/stop** an FTP
server on demand. Two options:
1. Embed a minimal FTP server in the payload (listen on a port,
   serve `/` with basic auth)
2. Spawn the existing ftpsrv.elf as a sub-payload

Option 1 is better (no external dependency, single payload).

**FTX2 Frame Types:** 212–215
```
FtpStart           = 212   // req: {"port":N,"root":"/","readonly":bool}
FtpStartAck        = 213   // ack: {"ok":bool,"port":N}
FtpStatus          = 214   // req: {}
FtpStatusAck       = 215   // ack: {"running":bool,"port":N,"connections":N}
```
(FTP stop reuses `FtpStart` with port=0.)

**Payload:** `ftp_server.c` — minimal FTP protocol implementation
(USER/PASS/LIST/RETR/STOR/CWD/MKD/DELE/RNFR/RNTO). pthread for each
client connection. Root path configurable.

**Engine:** `ftp.rs` — `ftp_start(addr, port, root, readonly)`,
`ftp_status(addr)`. Routes:
- `POST /api/ps5/ftp/start`
- `GET /api/ps5/ftp/status`

**Client:** Add FTP toggle card to Connection or Settings screen.
Shows FTP address (ps5-ip:port), credentials, connected clients count.

**Complexity:** Medium-high. A robust FTP server is ~1000 lines of C.
But the value is very high for scene users.

---

### P1-4: TMDB / PlayStation Store Metadata

**elf-arsenal source:** `src/tmdb.c` (~300 lines)

**What it does:** Fetches title metadata (full title, description,
developer, publisher, release date, genre, store art) from
`store.playstation.com`. Multi-region support (IP/UP/EP/HP/JP/UB
prefixes). 30-day cache on the PS5.

**Why it's valuable:** ps5upload currently scrapes a public title-info
site for cover art, which is fragile. TMDB (Sony's Title MetaData
database) is the official source — higher quality art, more metadata
fields, reliable availability.

**Sony APIs used:** `sceHttp*` (HTTPS GET to
store.playstation.com/store/api/...). Serialized behind
`sony_api_lock`.

**FTX2 Frame Types:** 216–217
```
TmdbFetch          = 216   // req: {"title_id":"CUSA...","region":"US"}
TmdbFetchAck       = 217   // ack: {"ok":bool,"data":{...},"cached":bool}
```

**Payload:** `tmdb.c` — HTTP GET via `sceHttp*` to Sony's store API,
parse JSON response, cache to `/data/ps5upload/tmdb/<title_id>.json`
with timestamp. Return cached if <30 days old.

**Engine:** `tmdb.rs` — `tmdb_fetch(addr, title_id, region)`. Route:
- `GET /api/ps5/tmdb?title_id=CUSA...&region=US`

**Client:** Replace or augment the current cover art scraping with
TMDB-backed metadata. Show rich title info on Library rows (genre,
release date, publisher, etc.).

**Complexity:** Low-medium. HTTP from the payload is already proven
(used by cheat repo downloads in elf-arsenal). JSON parsing exists.
Cache logic is simple.

---

### P1-5: SMB / Network Share Browser

**elf-arsenal source:** `src/smb.c` (~400 lines)

**What it does:** Browse SMB/CIFS network shares from the PS5. Uses
libsmb2 to connect to Windows/NAS/Linux shares and stream files
through to the UI.

**Why it's valuable:** Users with NAS setups or Windows shares can
browse and transfer files directly to/from the PS5 without a
middleman PC. Natural extension of ps5upload's file management.

**Sony APIs used:** libsmb2 (open-source, needs to be cross-compiled
for PS5/FreeBSD).

**FTX2 Frame Types:** 218–221
```
SmbConnect         = 218   // req: {"host":"..","share":"..","user":"..","password":".."}
SmbConnectAck      = 219   // ack: {"ok":bool,"shares":[...]}
SmbList            = 220   // req: {"path":".."}
SmbListAck         = 221   // ack: {"entries":[...]}
```

**Payload:** `smb.c` — embed libsmb2, expose connect/list/read
operations via FTX2. File transfer from SMB to local PS5 path would
use the existing transfer subsystem (new source type).

**Engine:** `smb.rs` — proxy functions. Routes under `/api/ps5/smb/*`.

**Client:** New "Network" sub-tab on File System browser. Connect
dialog (host/share/user/pass), browse remote files, transfer to/from
PS5.

**Complexity:** Medium-high. libsmb2 needs to be cross-compiled for
PS5 (FreeBSD/ARM64). The protocol integration is straightforward but
the dependency is non-trivial.

---

### P1-6: Firmware Spoof

**elf-arsenal source:** `payloads/ps5-fw-spoof.elf`

**What it does:** Patches the firmware version reported by the system
so games/App Store think the PS5 is on a newer firmware than it
actually is. This lets users on exploitable older firmware access PSN
content that requires a newer FW.

**Why it's valuable:** Critical for users staying on exploitable FW
(3.xx–6.xx) who want to access PSN store or play online.

**Implementation approach:** This is a standalone payload, not
something to embed in ps5upload's main payload. Instead, ps5upload
should detect whether fw-spoof is running (process name check) and
offer to start/stop it (spawn as sub-payload, like elf-arsenal does
with `spawn_embedded`).

**FTX2 Frame Types:** 222–223
```
FwSpoofStatus      = 222   // req: {}
FwSpoofStatusAck   = 223   // ack: {"running":bool,"real_fw":"..","spoofed_fw":".."}
```
(Start/stop would use the existing payload-spawn mechanism, not a
dedicated frame type.)

**Payload:** Detection only — check process list for known fw-spoof
process names. Actual spoofing is a kernel-level patch best left to a
dedicated payload.

**Engine:** `fw_spoof.rs` — `fw_spoof_status(addr)`. Route:
- `GET /api/ps5/fw-spoof/status`

**Client:** Status indicator on Dashboard or Settings. "Firmware
spoof: Active (7.50 → reporting 8.00)" or "Inactive".

**Complexity:** Low for detection-only. The actual spoofing payload is
out of scope (kernel patches, FW-specific offsets).

---

### P2-1: Game Fan Translation System

**elf-arsenal source:** `src/translate.c` (609 lines)

**What it does:** Fan translation system for game text. Maintains a
translation cache at `/data/elf-arsenal/i18n/`. Intercepts game text
requests and substitutes translated strings. Supports batch
translation.

**Why it's niche:** Only useful for playing JP/Asian-region games with
fan translations. Very small user base.

**Complexity:** High. Requires hooking into the game's text rendering
pipeline. Not a natural fit for ps5upload's architecture.

---

### P2-2: NP (PSN) Fake Sign-In / Account Restore

**elf-arsenal source:** `src/np.c`

**What it does:** Fake PSN account sign-in for offline use. Also
restores account data.

**Why it's niche:** Only relevant for users who lost their PSN account
data and can't re-sign-in (banned console, etc.). Very edge-case.

**Complexity:** Medium, but the risk of account corruption is high.

---

### P2-3: Offline Account Activation (Registry-Based)

**elf-arsenal source:** `src/offact.c`

**What it does:** Registry-based offline account setup. Sets account
name, ID, type, flags via `sceRegMgrSet*`. Up to 16 account slots.

**Why it's niche:** ps5upload already has profile/offline-account
management (create/delete/rename users, activate/clear slots). The
elf-arsenal approach goes deeper into the registry (setting account
IDs directly), which is useful only for advanced account
manipulation.

**Complexity:** Medium. Registry manipulation is risky. Partially
overlaps with existing profile management.

---

### P2-4: Linux Boot Loader

**elf-arsenal source:** `src/linux_loader.c`, `payloads/ps5-linux-loader.elf`

**What it does:** Boots Linux on PS5 (firmware ≤6.02).

**Why it's niche:** Extremely small user base. Requires specific FW,
specific hardware revision, and Linux on PS5 is barely usable
(limited GPU, no audio, etc.).

**Complexity:** Out of scope. The loader is a standalone payload.

---

### P2-5: Plugin Loader

**elf-arsenal source:** `src/plugin_loader.c`

**What it does:** Scans a directory for `.elf` files and spawns them
at boot with JB credentials. Sub-directories for file patches and
kernel patches.

**Why it's niche:** ps5upload already has a payload catalog + playlist
system + USB autoloader. A boot-time auto-spawn of arbitrary ELFs is
a power-user feature with security implications.

**Complexity:** Low, but overlaps with existing payload delivery.

---

### P2-6: KMonitor (Per-Game kstuff Auto-Pause/Resume)

**elf-arsenal source:** `src/kmonitor.c`

**What it does:** Monitors running titles via klog, auto-pauses/resumes
kstuff (kernel module hooks) per-game based on per-title delay rules,
whitelist/blacklist, crash detection with autotune.

**Why it's niche:** Only relevant for SMP/kstuff users experiencing
game-specific compatibility issues. Very advanced.

**Complexity:** High. Requires klog parsing, rule engine, integration
with kstuff.

---

### P2-7: HLTB (How Long To Beat) Proxy

**elf-arsenal source:** `hltb-proxy/`

**What it does:** Serverless proxy for HowLongToBeat game time data.

**Why it's niche:** Nice-to-have for completionists, but requires an
external API key and adds operational complexity.

**Complexity:** Low, but adds an external dependency (HLTB API).

---

### P2-8: App Dumper

**elf-arsenal source:** `src/dumper.c`

**What it does:** Bridges to ps5-app-dumper for dumping installed
games to pkg/IMG format.

**Why it's niche:** Game dumping is ethically gray and legally risky.
ps5upload has positioned itself as a tool, not a piracy tool. Skip.

---

### P2-9: fpkg-guard (Database Protection Daemon)

**elf-arsenal source:** `src/fpkg_guard.c`

**What it does:** Standalone daemon that locks fake package folders
(chmod 0555) to prevent Sony's Rebuild Database from deleting them.
Auto-snapshots DB after installs.

**Why it's niche:** Only relevant for users with many fpkg installs who
frequently hit DB rebuild. The locking mechanism (chmod 0555 on system
dirs) is risky and could cause boot issues.

**Complexity:** Medium, but high risk of bricking the console.

---

### P2-10: fpkg DB Repair

**elf-arsenal source:** `src/fpkg_db.c` (1880 lines)

**What it does:** Reconstructs app.db rows for PS4 fpkg installs after
Sony safe-mode DB rebuild. Uses on-disk data (param.sfo + appmeta) to
synthesize missing database rows.

**Why it's niche:** Very specific recovery scenario. ps5upload users
who hit DB rebuild would need this, but it's a rare event.

**Complexity:** High (1880 lines of SQLite + filesystem logic).

---

### P2-11: pkg-zone Browser

**elf-arsenal source:** `src/pkgzone.c`

**What it does:** Lists PS5 PKGs from `pkg-zone.com` with cover art.

**Why it's niche:** Piracy-adjacent. Skip for legal/ethical reasons.

---

## Summary: Recommended Roadmap

### v4.1 (Next Minor Release)
| Feature | Frame Types | Effort |
|---------|------------|--------|
| **P0-1: Remote Play PIN** | 188–191 | Medium |
| **P0-3: Fan Curve Editor** | 196–197 | Low-Medium |
| **P0-4: Persistent Notifications** | 198–199 | Low |

### v4.2
| Feature | Frame Types | Effort |
|---------|------------|--------|
| **P0-2: Activity Tracker** | 192–195 | Medium |
| **P1-2: SDK Version Changer** | 208–211 | Medium |
| **P1-4: TMDB Metadata** | 216–217 | Low-Medium |

### v5.0 (Major Release)
| Feature | Frame Types | Effort |
|---------|------------|--------|
| **P1-1: Cheat Engine** | 200–207 | Very High |
| **P1-3: FTP Server** | 212–215 | Medium-High |
| **P1-5: SMB Browser** | 218–221 | Medium-High |
| **P1-6: FW Spoof Detection** | 222–223 | Low |

### Frame Type Allocation (v4.x + v5.x)

| Range | Feature |
|-------|---------|
| 168–169 | DriveSensors (✅ done) |
| 170–173 | UserCreate/Delete (✅ done) |
| 176–183 | Backup Snapshot/List/Restore/Delete (✅ done) |
| 184–187 | SaveResign/SaveBinding (planned, v4.0) |
| 188–191 | RemotePlay (v4.1) |
| 192–195 | Activity/ActivityDb (v4.2) |
| 196–197 | FanCurve (v4.1) |
| 198–199 | NotifList (v4.1) |
| 200–207 | Cheats/XmlPatches (v5.0) |
| 208–211 | SdkVersionChanger (v4.2) |
| 212–215 | FTP Server (v5.0) |
| 216–217 | TMDB (v4.2) |
| 218–221 | SMB Browser (v5.0) |
| 222–223 | FwSpoof (v5.0) |

---

## Explicitly Skipped (Ethical/Legal/Scope)

- **Game Dumper** (P2-8) — piracy tool
- **pkg-zone Browser** (P2-11) — piracy-adjacent
- **PSN Fake Sign-In** (P2-2) — account fraud risk
- **Offline Account Registry Hacking** (P2-3) — overlaps with existing,
  risky
- **Linux Boot Loader** (P2-4) — out of scope, niche hardware hack
- **Plugin Loader** (P2-5) — overlaps with existing payload delivery
- **fpkg-guard** (P2-9) — high risk of bricking console
- **Game Fan Translation** (P2-1) — requires hooking game text
  rendering, not a natural fit

These features either overlap with existing capabilities, carry
unacceptable risk, or don't align with ps5upload's positioning as a
reliable utility tool rather than a piracy suite.
