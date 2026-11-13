//! The `mcframe` URI scheme: serves the shell page that runs model HTML live.
//!
//! A `srcdoc` or `blob:` frame would inherit the app's CSP (`script-src 'self'`), so
//! inline scripts in model HTML would be blocked. Instead the frame loads this
//! scheme, which the app serves from its own origin with the CSP below — and the
//! model's HTML itself only ever arrives by `postMessage`, never over HTTP.

/// The URI scheme registered in `lib.rs` (`mcframe://…` / `http://mcframe.localhost/…`).
pub const SCHEME: &str = "mcframe";

/// The CSP served with the shell, inherited by everything written into the frame.
/// Scripts may load from three public CDNs (chart libraries and friends); no fetch,
/// XHR, WebSocket, remote images (tracking pixels), nested frames or workers.
pub fn csp() -> &'static str {
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"
}

/// The shell page: waits for the parent to send the model's HTML, then replaces
/// itself with a prelude (theme colors, WebRTC stubs, height reporting) plus that
/// HTML. Everything runs inside the frame; nothing here trusts the network.
pub fn shell_html() -> &'static str {
    r##"<!doctype html>
<html>
<head><meta charset="utf-8"><title>Frame</title></head>
<body>
<script>
(function () {
  "use strict";
  parent.postMessage({ type: "mc-frame-ready" }, "*");
  function onMessage(e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type !== "mc-frame-render") return;
    if (typeof d.html !== "string" || typeof d.dark !== "boolean") return;
    window.removeEventListener("message", onMessage);
    var prelude =
      "<!doctype html><meta charset=\"utf-8\"><style>" +
      ":root{color-scheme:" + (d.dark ? "dark" : "light") + "}" +
      "html,body{margin:0;background:transparent}" +
      "body{font:15px/1.45 system-ui,sans-serif;color:" + (d.dark ? "#f4f4f5" : "#18181b") + ";padding:8px}" +
      "</style><script>" +
      "try{window.RTCPeerConnection=undefined}catch(e1){}" +
      "try{window.webkitRTCPeerConnection=undefined}catch(e1){}" +
      "try{window.RTCDataChannel=undefined}catch(e1){}" +
      "try{window.RTCSessionDescription=undefined}catch(e1){}" +
      // The body, not documentElement: the root's scrollHeight is never less than the
      // frame's own height, so the frame could grow but never shrink to its content.
      "function __report(){var b=document.body;if(!b)return;parent.postMessage({type:\"mc-frame-height\",height:Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height))},\"*\")}" +
      "window.addEventListener(\"load\",__report);" +
      // Keys typed in the frame don't reach the app, so forward Escape (closes Expand).
      "document.addEventListener(\"keydown\",function(e){if(e.key===\"Escape\")parent.postMessage({type:\"mc-frame-escape\"},\"*\")},true);" +
      "var __ro=new ResizeObserver(__report);__ro.observe(document.documentElement);" +
      "document.addEventListener(\"DOMContentLoaded\",function(){if(document.body)__ro.observe(document.body)});" +
      "<\/script>" +
      d.html;
    document.open();
    document.write(prelude);
    document.close();
  }
  window.addEventListener("message", onMessage);
})();
</script>
</body>
</html>"##
}

/// Answers a request for the shell. Any GET path returns the shell with its CSP;
/// anything else is refused, so the scheme can't be used to echo data back.
pub fn respond(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    if *request.method() != tauri::http::Method::GET {
        return tauri::http::Response::builder().status(405).body(Vec::new()).expect("static response");
    }
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", csp())
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(shell_html().as_bytes().to_vec())
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get() -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .method("GET")
            .uri("http://mcframe.localhost/frame.html")
            .body(Vec::new())
            .expect("request")
    }

    fn post() -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .method("POST")
            .uri("http://mcframe.localhost/frame.html")
            .body(b"nonsense".to_vec())
            .expect("request")
    }

    #[test]
    fn csp_sandboxes_and_cuts_the_network() {
        assert!(csp().starts_with("sandbox allow-scripts"));
        assert!(csp().contains("connect-src 'none'"));
        assert!(csp().contains("frame-src 'none'"));
        assert!(!csp().contains("allow-same-origin"));
    }

    #[test]
    fn get_serves_the_shell_with_csp() {
        let r = respond(&get());
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["Content-Type"], "text/html; charset=utf-8");
        assert_eq!(r.headers()["Content-Security-Policy"], csp());
        assert_eq!(r.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(r.headers()["Cache-Control"], "no-store");
        assert_eq!(r.body().as_slice(), shell_html().as_bytes());
    }

    #[test]
    fn other_methods_are_refused() {
        let r = respond(&post());
        assert_eq!(r.status(), 405);
        assert!(r.body().is_empty());
    }
}