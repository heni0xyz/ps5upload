//! Persistent notification browser over FTX2.

use anyhow::{bail, Result};
use ftx2_proto::FrameType;
use serde::{Deserialize, Serialize};

use crate::connection::Connection;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub msg: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationList {
    #[serde(default)]
    pub notifications: Vec<Notification>,
}

pub fn notif_list(addr: &str, since_seq: u64) -> Result<NotificationList> {
    let mut c = Connection::connect(addr)?;
    let body = serde_json::json!({ "since_seq": since_seq });
    c.send_frame(FrameType::NotifList, &serde_json::to_vec(&body)?)?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected NOTIF_LIST: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    if ft != FrameType::NotifListAck {
        bail!("expected NOTIF_LIST_ACK, got {ft:?}");
    }
    let parsed: NotificationList = serde_json::from_slice(&resp)?;
    Ok(parsed)
}
