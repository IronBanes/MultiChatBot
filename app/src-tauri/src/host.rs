//! Hosting the relay inside the desktop app, so friends can join without anyone
//! running the server separately. Phones can't keep a server running once the app
//! is in the background, so on mobile hosting reports itself as unsupported.

use serde::Serialize;
use std::net::{IpAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize)]
pub struct HostStatus {
    pub supported: bool,
    pub running: bool,
    pub port: Option<u16>,
    /// The port hosting is saved to resume on, even if it isn't running right now.
    pub saved_port: Option<u16>,
    /// Why hosting last failed to start, if it did.
    pub error: Option<String>,
    /// This machine's address on the local network, for phones on the same Wi-Fi.
    pub lan_ip: Option<String>,
    /// This machine's Tailscale address, if Tailscale is up.
    pub tailscale_ip: Option<String>,
}

pub struct Host {
    #[cfg_attr(mobile, allow(dead_code))]
    db_path: PathBuf,
    #[cfg(desktop)]
    relay: tokio::sync::Mutex<Option<multichat_relay::Relay>>,
    error: Mutex<Option<String>>,
}

impl Host {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            #[cfg(desktop)]
            relay: tokio::sync::Mutex::new(None),
            error: Mutex::new(None),
        }
    }

    fn set_error(&self, error: Option<String>) {
        if let Ok(mut e) = self.error.lock() {
            *e = error;
        }
    }

    pub async fn status(&self, saved_port: Option<u16>) -> HostStatus {
        #[cfg(desktop)]
        let (running, port) = {
            let relay = self.relay.lock().await;
            match relay.as_ref().filter(|r| r.is_running()) {
                Some(r) => (true, Some(r.local_addr().port())),
                None => (false, None),
            }
        };
        #[cfg(mobile)]
        let (running, port) = (false, None);
        HostStatus {
            supported: cfg!(desktop),
            running,
            port,
            saved_port,
            error: self.error.lock().ok().and_then(|e| e.clone()),
            lan_ip: lan_ip().map(|ip| ip.to_string()),
            tailscale_ip: tailscale_ip().map(|ip| ip.to_string()),
        }
    }

    /// Starts (or restarts) the relay on `port`, listening on every interface. If a
    /// running relay can't move to `port`, it's started again on its old port.
    #[cfg(desktop)]
    pub async fn start(&self, port: u16) -> Result<(), String> {
        let mut relay = self.relay.lock().await;
        let old_port = relay.as_ref().filter(|r| r.is_running()).map(|r| r.local_addr().port());
        // The old relay has to let go of its port first: a restart often reuses it.
        if let Some(old) = relay.take() {
            old.stop().await;
        }
        let db = self.db_path.to_string_lossy();
        match multichat_relay::start(&format!("0.0.0.0:{port}"), &db).await {
            Ok(r) => {
                *relay = Some(r);
                self.set_error(None);
                Ok(())
            }
            Err(e) => {
                if let Some(old_port) = old_port.filter(|&p| p != port)
                    && let Ok(r) = multichat_relay::start(&format!("0.0.0.0:{old_port}"), &db).await
                {
                    *relay = Some(r);
                }
                let in_use = e
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::AddrInUse);
                let msg = if in_use {
                    format!("Port {port} is already in use. Is another relay running, for example start.cmd --server?")
                } else {
                    format!("Could not start the relay: {e}")
                };
                self.set_error(Some(msg.clone()));
                Err(msg)
            }
        }
    }

    #[cfg(mobile)]
    pub async fn start(&self, _port: u16) -> Result<(), String> {
        Err("Hosting a relay is only available in the desktop app.".into())
    }

    pub async fn stop(&self) {
        #[cfg(desktop)]
        if let Some(r) = self.relay.lock().await.take() {
            r.stop().await;
        }
        self.set_error(None);
    }
}

/// The source address the OS would use to reach `target`. Connecting a UDP socket
/// only picks a route; nothing is sent.
fn route_ip(target: &str) -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(target).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

fn lan_ip() -> Option<IpAddr> {
    route_ip("8.8.8.8:80").filter(|ip| matches!(ip, IpAddr::V4(v4) if v4.is_private()))
}

/// Tailscale routes its own DNS address (100.100.100.100) over the tailnet, so the
/// source address for it is this machine's Tailscale IP when Tailscale is up.
fn tailscale_ip() -> Option<IpAddr> {
    route_ip("100.100.100.100:53").filter(|ip| matches!(ip, IpAddr::V4(v4) if v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64))
}
