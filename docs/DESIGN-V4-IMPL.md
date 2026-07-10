# ps5upload v4.0.0 — Implementation Specification

Detailed implementation plan for v4.0.0 features. Each section covers
payload C modules, FTX2 frame types, engine Rust routes, client screens,
and edge cases.

---

## Implementation Order

1. **G2: Drive SMART/temp sensors** — self-contained payload+engine+UI
2. **3.3: Permanent fan speed** — ✅ Already implemented (payload-side)
   - Remaining: expose pinned-threshold + persistence status to client
3. **3.4: User ID management** — extend read-only users to write ops
4. **G1: Backup & restore** — tag-based snapshot system
5. **3.2: Save management + resigning** — most complex; PFS mount logic

---

## Feature 1: Drive SMART / Temperature Sensors (G2)

### Problem
The Hardware screen shows CPU/SoC/M.2 temps but not internal SSD or
USB drive temperatures. elf-arsenal reads these via SCSI LOG SENSE
(page 0x0D) through CAM pass-through on `/dev/daN` devices.

### Payload: `drive_sensors.c` (new file)

Port from elf-arsenal `src/drive_sensors.c`. Key functions:

```c
// Enumerate /dev/da0..da9, read temp + capacity + ident + fs usage.
// Returns JSON array to the frame handler.
int drive_sensors_get_json(char *buf, size_t cap, size_t *written);
```

Implementation (from elf-arsenal reference):
- Open `/dev/da0` through `/dev/da9` with `O_RDONLY | O_NONBLOCK`
- Confirm block device via `ioctl(fd, DIOCGMEDIASIZE, &size)`
- Read ident string via `ioctl(fd, DIOCGIDENT, ident)`
- Read temperature via SCSI LOG SENSE (CAMIOCOMMAND, CDB opcode 0x4D,
  page 0x0D). Temp at byte[9], 0xFF = not available.
- Read filesystem usage via `getmntinfo()` matching the device path
- Include fixed storage (internal SSD + M.2) via `statvfs()`

### FTX2 Frame Types

```
HwDriveSensors     = 168   // req: empty body
HwDriveSensorsAck  = 169   // ack: {"drives":[{"device":"/dev/da0","sizeBytes":N,"ident":"...","tempC":N,"tempErr":N,"fsTotalBytes":N,"fsUsedBytes":N,"fsFreeBytes":N,"mountPoint":"..."}],"storage":[{"label":"Internal SSD","fsTotalBytes":N,...}]}
```

### Engine: `hw.rs` extension

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveSensor {
    pub device: String,
    pub size_bytes: u64,
    pub ident: Option<String>,
    pub temp_c: Option<i32>,
    pub temp_err: Option<i32>,
    pub fs_total_bytes: Option<u64>,
    pub fs_used_bytes: Option<u64>,
    pub fs_free_bytes: Option<u64>,
    pub mount_point: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveSensorList {
    pub drives: Vec<DriveSensor>,
    pub storage: Vec<FixedStorageEntry>,
}

pub fn drive_sensors(addr: &str) -> Result<DriveSensorList> {
    // Same connect/send/recv pattern as hw_info
}
```

### Engine Route

```
GET /api/ps5/hw/drive-sensors → DriveSensorList JSON
```

### Client

- `fetchDriveSensors()` in `api/ps5.ts`
- Dashboard: add drive temp cards (one per `daN` with tempC != null)
- Hardware screen: new "Drives" section with per-drive cards showing
  device, model, capacity, temp, and filesystem usage bar

### Edge Cases
- `/dev/daN` doesn't exist → skip (ENOENT is expected)
- Device exists but access denied → report `accessDenied: true`
- Drive doesn't support LOG SENSE temp → `tempC: null`, `tempErr: <code>`
- No drives at all → empty array, UI shows "No external drives detected"
- M.2 drive already reported via SoC channel 2; don't duplicate

---

## Feature 2: Permanent Fan Speed Status (3.3)

### Status: ✅ Payload-side complete

The payload already:
- Persists threshold to `/data/ps5upload/fan_threshold.conf`
- Loads on boot and re-applies via 15s watcher thread
- Atomic pin variable survives payload lifetime

### Remaining: Client-side status surface

The client needs to know:
1. Whether a threshold is currently pinned (and its value)
2. Whether it's persisted (survives reboot)

**Option A (simplest):** Extend `HwTemps` response to include
`fan_pinned_c` (int, 0 = not pinned) and `fan_persisted_c` (int).
The payload already has `hw_fan_pinned_threshold()` — just add it
to the existing temps JSON.

**No new frame types needed.** Modify `handle_hw_temps` to append
`"fan_pinned_c": N` to the response body.

### Client
- Hardware screen: show "Pinned: 55°C (persistent)" label next to
  the fan threshold slider when `fan_pinned_c > 0`
- Dashboard: green checkmark on fan card when pinned

---

## Feature 3: User ID Management (3.4)

### Problem
Currently `UserList` is read-only. Users need to create, delete, and
rename local accounts.

### Payload: Extend `users.c`

Current user enumeration uses:
- `sceUserServiceGetForegroundUser`
- `sceUserServiceGetLoginUserIdList`
- `sceUserServiceGetUserName`

**New operations:**

```c
// Create a new local user. Returns the new user_id.
// sceUserServiceCreateUser creates the home dir, initial registry,
// and savedata folders.
int user_create(const char *name, int *out_uid, const char **err);

// Delete a user by user_id. Optionally wipe their savedata.
// sceUserServiceDeleteUser removes the account; we additionally
// clean up /user/home/<uid>/ to remove residual files.
int user_delete(int uid, int wipe_saves, const char **err);

// Rename an existing user.
// sceUserServiceSetUserName (already used by ProfileSetLocalUsername).
// This is just a frame-type alias for UI discoverability.
int user_rename(int uid, const char *name, const char **err);
```

### FTX2 Frame Types

```
UserCreate      = 170   // req: {"name":"Player 2"}
UserCreateAck   = 171   // ack: {"ok":true,"uid":N} | error
UserDelete      = 172   // req: {"uid":N,"wipe_saves":bool}
UserDeleteAck   = 173   // ack: {"ok":true,"uid":N}
UserRename      = 174   // req: {"uid":N,"name":".."}
UserRenameAck   = 175   // ack: {"ok":true,"uid":N,"name":".."}
```

### Engine: `users.rs` extension

```rust
pub fn user_create(addr: &str, name: &str) -> Result<UserCreateResult>;
pub fn user_delete(addr: &str, uid: i32, wipe_saves: bool) -> Result<()>;
pub fn user_rename(addr: &str, uid: i32, name: &str) -> Result<()>;
```

### Engine Routes

```
POST /api/ps5/users/create    {"name":".."} → {"uid":N}
POST /api/ps5/users/delete    {"uid":N,"wipe_saves":bool}
POST /api/ps5/users/rename    {"uid":N,"name":".."}
```

### Client Screen

Extend existing **Profile** screen with a "Users" sub-tab:
- List all users with their avatar, name, and "foreground" badge
- Per-user actions: Rename, Delete (with confirmation dialog)
- "Create User" button → name input → create
- Delete shows warning: "This will remove the account and all saves"

### Edge Cases
- `sceUserServiceCreateUser` may fail if max user count reached (16)
- Delete foreground user → must promote another user first
- Delete with `wipe_saves=true` → recursive `nftw` removal of
  `/user/home/<uid>/savedata*` before `DeleteUser`
- Rename to empty string → reject client-side
- Creating a user requires the payload's ucred elevation (same as
  profile operations)

### Authid
User management requires authid `0x3800000000000012` (system service).
The payload already runs elevated after `ucred_fix`.

---

## Feature 4: Backup & Restore (G1)

### Problem
No way to snapshot and restore system state (app.db, registry, saves,
trophies) before risky operations.

### Payload: `backup.c` (new file)

Port tag-based snapshot system from elf-arsenal. Design:

```
/data/ps5upload/backups/<tag>/<unix_timestamp>/
    .manifest          # flattened: basename \t original_path per line
    <flattened_files>  # actual backed-up data
/data/ps5upload/backups/.last-job.json  # status of last backup/restore
```

**Operations:**

```c
// Snapshot a single file or directory tree under a tag.
// Returns snapshot path + file count + total bytes.
int backup_snapshot(const char *tag, const char *src_path,
                    char *out_path, size_t path_sz,
                    int *out_file_count, uint64_t *out_bytes);

// List all snapshots under a tag (or all tags).
int backup_list(const char *tag_filter,
                char *buf, size_t cap, size_t *written);

// Restore a snapshot by timestamp. Reads .manifest, copies each
// file back to its original path. Atomic per-file (temp + rename).
int backup_restore(const char *tag, int64_t timestamp,
                   const char **err);

// Delete a snapshot.
int backup_delete(const char *tag, int64_t timestamp);

// Prune: keep at most N snapshots per tag (default 5).
int backup_prune(const char *tag, int keep);
```

**Default backup targets** (snapshot all at once via "full backup"):

| Tag | Path(s) |
|-----|---------|
| `app-db` | `/system_data/priv/mms/app.db` |
| `registry` | `/system_data/priv/mms/reg*` (glob) |
| `saves-<uid>` | `/user/home/<uid>/savedata/`, `/user/home/<uid>/savedata_prospero/` |
| `trophies-<uid>` | `/user/home/<uid>/trophy/` |
| `profile` | `/user/home/<uid>/share/` (avatars, etc.) |

### FTX2 Frame Types

```
BackupSnapshot     = 176   // req: {"tag":"app-db","path":"/system_data/priv/mms/app.db"}
BackupSnapshotAck  = 177   // ack: {"ok":true,"snapshot":"<ts>","files":N,"bytes":N}
BackupList         = 178   // req: {"tag":"app-db"} or {"tag":""} for all
BackupListAck      = 179   // ack: {"snapshots":[{"tag":"..","timestamp":N,"files":N,"bytes":N}]}
BackupRestore      = 180   // req: {"tag":"app-db","timestamp":N}
BackupRestoreAck   = 181   // ack: {"ok":true,"files_restored":N}
BackupDelete       = 182   // req: {"tag":"..","timestamp":N}
BackupDeleteAck    = 183   // ack: {"ok":true}
```

### Engine: `backup.rs` (new module)

```rust
pub fn backup_snapshot(addr: &str, tag: &str, path: &str) -> Result<BackupSnapshotResult>;
pub fn backup_list(addr: &str, tag: &str) -> Result<BackupList>;
pub fn backup_restore(addr: &str, tag: &str, timestamp: i64) -> Result<BackupRestoreResult>;
pub fn backup_delete(addr: &str, tag: &str, timestamp: i64) -> Result<()>;
```

### Engine Routes

```
POST /api/ps5/backup/snapshot   {"tag":"..","path":".."} → result
GET  /api/ps5/backup/list?tag=.. → snapshots array
POST /api/ps5/backup/restore    {"tag":"..","timestamp":N} → result
POST /api/ps5/backup/delete     {"tag":"..","timestamp":N}
```

### Client Screen: "Backup & Restore" (new)

Route: `/backup`

Layout:
- **Left panel**: Tag list (app-db, registry, saves-1, trophies-1, etc.)
  with "Create Snapshot" button per tag
- **Right panel**: Snapshots for selected tag, sorted by date
  - Each row: timestamp, file count, size, [Restore] [Delete] buttons
- **Top bar**: "Full Backup" button (snapshots all default targets),
  auto-prune setting toggle
- Restore shows confirmation dialog: "Restore snapshot from 2024-01-15?
  This will overwrite current [tag] data."

### Edge Cases
- Source path doesn't exist → error, no empty snapshot
- Disk full during snapshot → cleanup partial, return error
- Restore over a running system → app.db may be locked; the payload
  should `flock()` or note "restore will take effect after reboot"
- Symlinks in source tree → skip (don't follow, don't copy the link)
- Max depth 8 levels (prevent runaway on corrupt FS)
- Pruning protects "initial" tag (the first-ever snapshot)
- Concurrent snapshots to same tag → mutex per tag
- Tag names sanitized: `[a-z0-9_-]` only, max 32 chars

---

## Feature 5: Save Data Management + Resigning (3.2)

### Problem
Users can list and download/upload saves but can't resign them to a
different account. Save resigning patches `savedata_param.sfo` to
change the account binding.

### Background: PS5 Save Structure

PS5 saves live at:
```
/user/home/<uid>/savedata_prospero/<title_id>/
    savedata_param.sfo    # account binding + metadata
    <save_files...>
```

PS4 saves (backward compat) live at:
```
/user/home/<uid>/savedata/<title_id>/
    sdimg_<title_id>      # PFS image with sealed key at offset 0x800
```

### Resigning Approach

The `savedata_param.sfo` contains:
- `accountId` (8 bytes, binary) — the PSN account ID
- `userId` (int32) — the local user ID

**Resigning** means:
1. Read the source save's `savedata_param.sfo`
2. Patch `accountId` → target account's ID
3. Patch `userId` → target user's local ID
4. Write back

For PS4 saves (PFS images), this is more complex — the sealed key
needs re-encryption for the target account. This requires the
pfsmgr ioctl to unseal → re-seal. This is **harder and riskier**;
we'll ship PS5 save resigning first, PS4 as a follow-up.

### Payload: `save_mgr.c` (new file)

```c
// Resign a PS5 save to a target user.
// Reads savedata_param.sfo, patches accountId + userId, writes back.
// Returns 0 on success, -1 with err_reason set.
int save_resign_ps5(const char *save_path, int target_uid,
                    const char *target_account_id_hex,
                    const char **err_reason);

// Get the current binding info from a save.
int save_get_binding(const char *save_path,
                     int *out_uid, char *out_account_id, size_t id_sz);

// For PS4 saves: extract the sealed key, unseal via pfsmgr,
// re-seal for the target, and patch the image. (Phase 2.)
int save_resign_ps4(const char *save_path, int target_uid,
                    const char **err_reason);
```

### FTX2 Frame Types

```
SaveResign       = 184   // req: {"path":"/user/home/3/savedata_prospero/CUSA.../","target_uid":3,"target_account_id":"a1b2c3..."}
SaveResignAck    = 185   // ack: {"ok":true,"path":"..","uid":N,"account_id":".."}
SaveBinding      = 186   // req: {"path":".."}
SaveBindingAck   = 187   // ack: {"uid":N,"account_id":"..","platform":"ps5"}
```

### Engine: Extend `saves.rs`

```rust
pub fn save_resign(addr: &str, path: &str, target_uid: i32,
                    target_account_id: &str) -> Result<SaveResignResult>;
pub fn save_get_binding(addr: &str, path: &str) -> Result<SaveBinding>;
```

### Engine Routes

```
POST /api/ps5/saves/resign   {"path":"..","target_uid":N,"target_account_id":".."}
GET  /api/ps5/saves/binding?path=.. → binding info
```

### Client: Extend Saves Screen

The Saves screen already has backup (zip) and restore. Add:

- **Per-save dropdown menu**: Backup | Restore | **Resign** | Delete
- **Resign dialog**: 
  - Shows current binding: "Account: abc123... User: Player 1 (uid=3)"
  - Target user dropdown (from `user_list`)
  - Target account ID field (auto-filled from target user's profile,
    or manual hex entry for offline accounts)
  - Warning: "This permanently modifies the save data. Back up first."
- **Resign indicator**: After resign, the save row shows a "resigned"
  badge with the new account ID

### Edge Cases
- `savedata_param.sfo` not found → error "not a valid PS5 save"
- Save is currently in use (game running) → `EBUSY`, client shows
  "Close the game before resigning"
- Target account ID format validation (must be valid hex, 16 chars)
- PS4 saves → show "PS4 save resigning not yet supported" message
- Backup before resign → auto-create a `.bak` copy of param.sfo
  (payload creates `<save_path>/savedata_param.sfo.bak` before patching)
- Atomic write: write to temp, fsync, rename over original

### Implementation Phases
- **Phase 1 (v4.0):** PS5 save resigning (param.sfo patch)
- **Phase 2 (v4.1):** PS4 save resigning (PFS unseal/re-seal via pfsmgr)
- **Phase 3 (v4.2+):** Cross-console save transfer (requires NP ticket)

---

## FTX2 Frame Type Allocation Summary

| Range | Feature |
|-------|---------|
| 168–169 | HwDriveSensors / Ack |
| 170–175 | UserCreate/Delete/Rename (+ Acks) |
| 176–183 | Backup Snapshot/List/Restore/Delete (+ Acks) |
| 184–187 | SaveResign / SaveBinding (+ Acks) |

All new frame types are ≥168, well clear of the existing max (167).

---

## Testing Strategy

### Payload (C)
- Unit tests for drive_sensors mock (compile-check on host)
- Manual test: verify temp reads on real PS5 with M.2 + USB drives
- Manual test: user create/delete/rename flow
- Manual test: backup/restore app.db → kill payload → verify data

### Engine (Rust)
- Existing test pattern: mock Connection, verify frame round-trip
- `cargo test` for each new module (saves, users, backup, hw)
- Integration test: `drive_sensors_get_json` parsing
- Parity tests in `ftx2-proto` for new frame types

### Client (TypeScript)
- API function tests (mock `invoke`)
- Screen component tests with `@testing-library/react`
- i18n keys for all new UI text

### CI
- `cargo fmt --check`, `cargo clippy`, `cargo test`
- `npm run typecheck`, `npm test`
- i18n coverage check (add new keys to allowlist)
- Version sync check

---

## i18n Keys Needed

```
dashboard_label_drive_temp
hardware_label_drives
hardware_drive_no_drives
hardware_drive_access_denied
hardware_drive_temp_na
hardware_fan_pinned
hardware_fan_persistent
users_button_create
users_button_delete
users_button_rename
users_create_title
users_create_name_label
users_delete_confirm
users_delete_wipe_saves
users_delete_warning_foreground
backup_title
backup_description
backup_button_full_backup
backup_button_snapshot
backup_button_restore
backup_button_delete
backup_column_tag
backup_column_timestamp
backup_column_files
backup_column_size
backup_restore_confirm
backup_pruning_enabled
saves_button_resign
saves_resign_title
saves_resign_current_binding
saves_resign_target_user
saves_resign_target_account
saves_resign_warning
saves_ps4_resign_unsupported
saves_resign_success
```

---

## Risk Assessment

| Feature | Risk | Mitigation |
|---------|------|------------|
| Drive sensors | Low — read-only CAM ioctl | Ship first, isolated |
| Fan speed status | Low — payload already done | Just expose status |
| User management | Medium — irreversible ops | Confirmation dialogs, require foreground user |
| Backup/restore | Medium — disk space risk | Space check before snapshot, auto-prune |
| Save resigning | High — corrupts saves | Auto-backup param.sfo, atomic writes, PS5-only first |
