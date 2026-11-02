//! Network address helpers.

use std::net::IpAddr;

/// True if `url`'s host is on this device or the local network: localhost, `.local`
/// (mDNS) names, and loopback, private (RFC 1918 / IPv6 ULA) or link-local addresses.
/// Shared address space (100.64.0.0/10) is deliberately excluded: Tailscale uses it,
/// but so do carrier networks, so an address there doesn't prove the traffic is private.
/// Only enforced on mobile, but compiled and tested everywhere.
#[cfg_attr(desktop, allow(dead_code))]
pub fn is_local_host(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    let Some(host) = parsed.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local()
        }
        Ok(IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_local_host;

    #[test]
    fn local_and_public_hosts() {
        for url in [
            "ws://127.0.0.1:8787/ws",
            "ws://localhost:8787/ws",
            "ws://192.168.1.20:8787/ws",
            "ws://10.0.0.5/ws",
            "ws://172.20.1.1/ws",
            "ws://my-pc.local:8787/ws",
            "ws://[::1]:8787/ws",
            "ws://[fd12::1]/ws",
            "http://169.254.10.10/mcp",
        ] {
            assert!(is_local_host(url), "{url} should be local");
        }
        for url in [
            "ws://example.com/ws",
            "ws://8.8.8.8/ws",
            "ws://172.32.0.1/ws",
            "ws://100.101.102.103:8787/ws", // shared address space (Tailscale or a carrier)
            "ws://100.128.0.1/ws",
            "ws://[2001:db8::1]/ws",
            "not a url",
        ] {
            assert!(!is_local_host(url), "{url} should not be local");
        }
    }
}
