//! Tag-based backup & restore over FTX2.
//!
//! Snapshots are stored on the PS5 at
//! `/data/ps5upload/backups/<tag>/<unix_timestamp>/`. Each snapshot has
//! a `.manifest` (basename → original-path mapping) and flattened copies
//! of the source files. Restore reads the manifest and copies each file
//! back to its original path.

use anyhow::{bail, Result};
use ftx2_proto::FrameType;
use serde::{Deserialize, Serialize};

use crate::connection::Connection;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSnapshotResult {
    pub ok: bool,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub files: i32,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub err: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupEntry {
    pub tag: String,
    pub timestamp: i64,
    pub files: i32,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupList {
    pub snapshots: Vec<BackupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRestoreResult {
    pub ok: bool,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub restored: i32,
    #[serde(default)]
    pub err: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupDeleteResult {
    pub ok: bool,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub err: String,
}

/// Tag validation: `[a-zA-Z0-9_-]`, 1–32 chars. Mirrors the payload
/// check so we reject bad input before round-tripping.
pub fn validate_tag(tag: &str) -> Result<()> {
    if tag.is_empty() || tag.len() > 32 {
        bail!("tag must be 1–32 characters");
    }
    for c in tag.chars() {
        if !c.is_ascii_alphanumeric() && c != '-' && c != '_' {
            bail!("tag may only contain [a-zA-Z0-9_-]");
        }
    }
    Ok(())
}

pub fn backup_snapshot(addr: &str, tag: &str, path: &str) -> Result<BackupSnapshotResult> {
    validate_tag(tag)?;
    let mut c = Connection::connect(addr)?;
    let body = serde_json::json!({ "tag": tag, "path": path });
    c.send_frame(FrameType::BackupSnapshot, &serde_json::to_vec(&body)?)?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected BACKUP_SNAPSHOT: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    if ft != FrameType::BackupSnapshotAck {
        bail!("expected BACKUP_SNAPSHOT_ACK, got {ft:?}");
    }
    let parsed: BackupSnapshotResult = serde_json::from_slice(&resp)?;
    if !parsed.ok {
        bail!(
            "snapshot failed: {}",
            if parsed.err.is_empty() {
                "unknown error"
            } else {
                &parsed.err
            }
        );
    }
    Ok(parsed)
}

pub fn backup_list(addr: &str, tag: &str) -> Result<BackupList> {
    let mut c = Connection::connect(addr)?;
    let body = serde_json::json!({ "tag": tag });
    c.send_frame(FrameType::BackupList, &serde_json::to_vec(&body)?)?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected BACKUP_LIST: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    if ft != FrameType::BackupListAck {
        bail!("expected BACKUP_LIST_ACK, got {ft:?}");
    }
    let parsed: BackupList = serde_json::from_slice(&resp)?;
    Ok(parsed)
}

pub fn backup_restore(addr: &str, tag: &str, timestamp: i64) -> Result<BackupRestoreResult> {
    validate_tag(tag)?;
    let mut c = Connection::connect(addr)?;
    let body = serde_json::json!({ "tag": tag, "timestamp": timestamp });
    c.send_frame(FrameType::BackupRestore, &serde_json::to_vec(&body)?)?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected BACKUP_RESTORE: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    if ft != FrameType::BackupRestoreAck {
        bail!("expected BACKUP_RESTORE_ACK, got {ft:?}");
    }
    let parsed: BackupRestoreResult = serde_json::from_slice(&resp)?;
    if !parsed.ok {
        bail!(
            "restore failed: {}",
            if parsed.err.is_empty() {
                "unknown error"
            } else {
                &parsed.err
            }
        );
    }
    Ok(parsed)
}

pub fn backup_delete(addr: &str, tag: &str, timestamp: i64) -> Result<()> {
    validate_tag(tag)?;
    let mut c = Connection::connect(addr)?;
    let body = serde_json::json!({ "tag": tag, "timestamp": timestamp });
    c.send_frame(FrameType::BackupDelete, &serde_json::to_vec(&body)?)?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected BACKUP_DELETE: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    if ft != FrameType::BackupDeleteAck {
        bail!("expected BACKUP_DELETE_ACK, got {ft:?}");
    }
    let parsed: BackupDeleteResult = serde_json::from_slice(&resp)?;
    if !parsed.ok {
        bail!(
            "delete failed: {}",
            if parsed.err.is_empty() {
                "unknown error"
            } else {
                &parsed.err
            }
        );
    }
    Ok(())
}
