//! Remote Play PIN generation over FTX2.

use anyhow::{bail, Result};
use ftx2_proto::FrameType;
use serde::{Deserialize, Serialize};

use crate::connection::Connection;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemotePlayStatus {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub pin: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub seconds_left: i32,
}

pub fn remoteplay_request(addr: &str, manual_account_id: Option<&str>) -> Result<()> {
    let mut c = Connection::connect(addr)?;
    let body = serde_json::json!({ "manual_account_id": manual_account_id.unwrap_or("") });
    c.send_frame(FrameType::RemotePlayRequest, &serde_json::to_vec(&body)?)?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected REMOTEPLAY_REQUEST: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    Ok(())
}

pub fn remoteplay_status(addr: &str) -> Result<RemotePlayStatus> {
    let mut c = Connection::connect(addr)?;
    c.send_frame(FrameType::RemotePlayStatus, &[])?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected REMOTEPLAY_STATUS: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    if ft != FrameType::RemotePlayStatus {
        bail!("expected REMOTEPLAY_STATUS response, got {ft:?}");
    }
    let parsed: RemotePlayStatus = serde_json::from_slice(&resp)?;
    Ok(parsed)
}

pub fn remoteplay_cancel(addr: &str) -> Result<()> {
    let mut c = Connection::connect(addr)?;
    c.send_frame(FrameType::RemotePlayCancel, &[])?;
    let (hdr, resp) = c.recv_frame()?;
    let ft = hdr.frame_type().unwrap_or(FrameType::Error);
    if ft == FrameType::Error {
        bail!(
            "payload rejected REMOTEPLAY_CANCEL: {}",
            String::from_utf8_lossy(&resp)
        );
    }
    Ok(())
}
