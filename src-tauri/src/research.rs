//! Public HTTPS research. No browsing session, credentials, proxy, or redirects.
use std::{
    future::Future,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    time::{Duration, Instant},
};

use reqwest::{header, redirect, Client, ClientBuilder, StatusCode, Url};

const MAX_URL_BYTES: usize = 2_048;
const MAX_BODY_BYTES: usize = 512 * 1_024;
const MAX_TEXT_CHARS: usize = 3_200;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const CANCEL_POLL: Duration = Duration::from_millis(50);
static DNS_LOOKUP_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

pub(crate) struct Document {
    pub(crate) url: String,
    pub(crate) text: String,
}

pub(crate) fn public_url(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) || raw.contains('\\') {
        return Err("Research requires a bounded public HTTPS URL.".into());
    }
    let mut url = Url::parse(raw).map_err(|_| "Invalid research URL.".to_owned())?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || host.parse::<IpAddr>().is_ok()
        || !host.contains('.')
        || host.ends_with('.')
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        || ["localhost", "local", "internal", "test", "invalid", "onion"]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err(
            "Research requires a public HTTPS page without credentials or a custom port.".into(),
        );
    }
    url.set_fragment(None);
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            a > 0
                && a < 224
                && a != 10
                && a != 127
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192
                    && (b == 168 || (b == 0 && [0, 2].contains(&c)) || (b == 88 && c == 99)))
                && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let parts = ip.segments();
            // Global unicast only; exclude IETF special use, documentation and transition ranges.
            (parts[0] & 0xe000) == 0x2000
                && !(parts[0] == 0x2001 && (parts[1] < 0x0200 || parts[1] == 0x0db8))
                && parts[0] != 0x2002
                && parts[0] != 0x3ffe
                && !(parts[0] == 0x3fff && (parts[1] & 0xf000) == 0)
        }
    }
}

fn checked_address(addresses: impl IntoIterator<Item = SocketAddr>) -> Result<SocketAddr, String> {
    let mut first = None;
    for (index, address) in addresses.into_iter().enumerate() {
        if index >= 32 || !public_ip(address.ip()) || address.port() != 443 {
            return Err("Research destination resolved outside the public internet.".into());
        }
        first.get_or_insert(address);
    }
    first.ok_or_else(|| "Research destination has no public address.".into())
}

async fn resolve_public_address(
    host: &str,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> Result<SocketAddr, String> {
    let permit = bounded(
        DNS_LOOKUP_SLOTS.acquire(),
        deadline.min(Instant::now() + DNS_TIMEOUT),
        cancelled,
    )
    .await?
    .map_err(|_| "Could not resolve the public research destination.".to_owned())?;
    let host = host.to_owned();
    // OS getaddrinfo cannot be interrupted. Keep a permit inside its blocking closure so
    // cancelled lookups remain concurrency-bounded until the resolver actually returns.
    let lookup = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        (host.as_str(), 443)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    });
    let addresses = bounded(
        lookup,
        deadline.min(Instant::now() + DNS_TIMEOUT),
        cancelled,
    )
    .await?
    .map_err(|_| "Could not resolve the public research destination.".to_owned())?
    .map_err(|_| "Could not resolve the public research destination.".to_owned())?;
    checked_address(addresses)
}

async fn bounded<F: Future>(
    future: F,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> Result<F::Output, String> {
    let mut future = std::pin::pin!(future);
    loop {
        if cancelled() {
            return Err("Task cancelled.".into());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "Public research timed out.".to_owned())?;
        if let Ok(result) = tokio::time::timeout(remaining.min(CANCEL_POLL), future.as_mut()).await
        {
            if cancelled() {
                return Err("Task cancelled.".into());
            }
            return Ok(result);
        }
    }
}

fn client_builder(host: &str, address: SocketAddr) -> Result<ClientBuilder, String> {
    // Bundled roots avoid platform certificate verification fetching extra URLs.
    let roots = webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        .map(|cert| reqwest::Certificate::from_der(cert.as_ref()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Could not initialize research trust roots.".to_owned())?;
    Ok(Client::builder()
        .tls_certs_only(roots)
        .https_only(true)
        .http1_only()
        .no_proxy()
        .redirect(redirect::Policy::none())
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .timeout(REQUEST_TIMEOUT)
        .resolve(host, address)
        .pool_max_idle_per_host(0))
}

fn validate_response(status: StatusCode, headers: &header::HeaderMap) -> Result<(), String> {
    if status != StatusCode::OK {
        return Err(
            "Research requires a direct successful text response; redirects are not followed."
                .into(),
        );
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim();
    if !content_type.eq_ignore_ascii_case("text/plain")
        && !content_type.eq_ignore_ascii_case("text/html")
    {
        return Err("Research supports only HTML or plain text.".into());
    }
    if headers
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .any(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err("Compressed research responses are not supported.".into());
    }
    if let Some(value) = headers.get(header::CONTENT_LENGTH) {
        let length = value
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| "Invalid research response length.".to_owned())?;
        if length > MAX_BODY_BYTES as u64 {
            return Err("Public page exceeds 512 KiB.".into());
        }
    }
    Ok(())
}

fn append_body(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if chunk.len() > MAX_BODY_BYTES.saturating_sub(body.len()) {
        return Err("Public page exceeds 512 KiB.".into());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

pub(crate) fn read(raw: &str, cancelled: &impl Fn() -> bool) -> Result<Document, String> {
    let url = public_url(raw)?;
    tauri::async_runtime::block_on(async {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let host = url.host_str().expect("validated research host");
        let address = resolve_public_address(host, deadline, cancelled).await?;
        if cancelled() {
            return Err("Task cancelled.".into());
        }
        // URL retains the hostname for certificate verification; only resolution is replaced.
        let client = client_builder(host, address)?
            .build()
            .map_err(|_| "Could not initialize secure public research.".to_owned())?;
        let request = client
            .get(url.clone())
            .header(header::ACCEPT, "text/html,text/plain")
            .header(header::ACCEPT_ENCODING, "identity")
            .send();
        let mut response = bounded(request, deadline, cancelled)
            .await?
            .map_err(|_| "Public HTTPS research request failed.".to_owned())?;
        validate_response(response.status(), response.headers())?;
        let mut body = Vec::new();
        while let Some(chunk) = bounded(response.chunk(), deadline, cancelled)
            .await?
            .map_err(|_| "Could not read the public research response.".to_owned())?
        {
            append_body(&mut body, &chunk)?;
        }
        let text = String::from_utf8(body)
            .map_err(|_| "Public research response must be UTF-8 text.".to_owned())?;
        let truncated = text.chars().count() > MAX_TEXT_CHARS;
        let mut text = text.chars().take(MAX_TEXT_CHARS).collect::<String>();
        if truncated {
            text.push_str("\n[truncated]");
        }
        Ok(Document {
            url: url.into(),
            text,
        })
    })
}

pub(crate) fn search_url(query: &str) -> Result<String, String> {
    if query.trim().is_empty() || query.len() > 256 || query.chars().any(char::is_control) {
        return Err("Public search requires a query up to 256 UTF-8 bytes.".into());
    }
    let mut url = Url::parse("https://html.duckduckgo.com/html/").expect("fixed search endpoint");
    url.query_pairs_mut().append_pair("q", query.trim());
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TLS_TEST_CERT: &[u8] = &[
        0x30, 0x82, 0x01, 0xab, 0x30, 0x82, 0x01, 0x51, 0xa0, 0x03, 0x02, 0x01, 0x02, 0x02, 0x14,
        0x25, 0x6a, 0xc9, 0x0a, 0xda, 0x94, 0x73, 0x25, 0xfa, 0x91, 0x05, 0xaf, 0x43, 0x97, 0x4f,
        0x61, 0xf5, 0x32, 0xdc, 0x9b, 0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04,
        0x03, 0x02, 0x30, 0x1b, 0x31, 0x19, 0x30, 0x17, 0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, 0x10,
        0x72, 0x65, 0x73, 0x65, 0x61, 0x72, 0x63, 0x68, 0x2e, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c,
        0x65, 0x30, 0x20, 0x17, 0x0d, 0x32, 0x36, 0x31, 0x31, 0x32, 0x37, 0x30, 0x32, 0x35, 0x31,
        0x32, 0x32, 0x5a, 0x18, 0x0f, 0x32, 0x31, 0x32, 0x36, 0x31, 0x31, 0x30, 0x33, 0x30, 0x32,
        0x35, 0x31, 0x32, 0x32, 0x5a, 0x30, 0x1b, 0x31, 0x19, 0x30, 0x17, 0x06, 0x03, 0x55, 0x04,
        0x03, 0x0c, 0x10, 0x72, 0x65, 0x73, 0x65, 0x61, 0x72, 0x63, 0x68, 0x2e, 0x65, 0x78, 0x61,
        0x6d, 0x70, 0x6c, 0x65, 0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d,
        0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
        0x04, 0x85, 0x02, 0x1b, 0xba, 0xb7, 0x6d, 0x42, 0xe6, 0xd7, 0xaf, 0xd9, 0xc1, 0xc3, 0xf2,
        0xf2, 0x7a, 0x98, 0xab, 0x54, 0xfb, 0x40, 0x69, 0x32, 0xa1, 0x7d, 0xfe, 0x89, 0x2c, 0xcb,
        0x96, 0x0b, 0x11, 0x60, 0x75, 0x2a, 0x0e, 0x5b, 0xd8, 0x63, 0x59, 0xf2, 0xa5, 0xc9, 0xf2,
        0x7b, 0xa8, 0xea, 0x38, 0x74, 0x68, 0x2f, 0x65, 0x36, 0xa8, 0xde, 0x40, 0xc7, 0xf9, 0x99,
        0x9a, 0xfa, 0x55, 0xc1, 0x99, 0xa3, 0x71, 0x30, 0x6f, 0x30, 0x1d, 0x06, 0x03, 0x55, 0x1d,
        0x0e, 0x04, 0x16, 0x04, 0x14, 0x36, 0xf9, 0xc5, 0x56, 0xd4, 0xe5, 0x09, 0x0a, 0x70, 0xd5,
        0x25, 0x7e, 0x66, 0x78, 0xcf, 0x07, 0xbd, 0x67, 0x91, 0x6d, 0x30, 0x1b, 0x06, 0x03, 0x55,
        0x1d, 0x11, 0x04, 0x14, 0x30, 0x12, 0x82, 0x10, 0x72, 0x65, 0x73, 0x65, 0x61, 0x72, 0x63,
        0x68, 0x2e, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x30, 0x0c, 0x06, 0x03, 0x55, 0x1d,
        0x13, 0x01, 0x01, 0xff, 0x04, 0x02, 0x30, 0x00, 0x30, 0x0e, 0x06, 0x03, 0x55, 0x1d, 0x0f,
        0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x07, 0x80, 0x30, 0x13, 0x06, 0x03, 0x55, 0x1d,
        0x25, 0x04, 0x0c, 0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,
        0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02, 0x03, 0x48, 0x00,
        0x30, 0x45, 0x02, 0x21, 0x00, 0xb4, 0x92, 0x52, 0xc8, 0x96, 0xa5, 0x2b, 0xcd, 0x5c, 0x92,
        0x45, 0xc6, 0x7f, 0xf2, 0xbb, 0xea, 0xb3, 0xd0, 0x73, 0xce, 0xd1, 0x5a, 0x35, 0x5a, 0x81,
        0xa2, 0xff, 0x82, 0x03, 0xf3, 0x3c, 0xda, 0x02, 0x20, 0x09, 0x89, 0xd4, 0xb2, 0xd3, 0x2a,
        0x16, 0x9d, 0x5c, 0xf3, 0x1b, 0x2c, 0x91, 0x02, 0x28, 0xd3, 0xbe, 0xda, 0x76, 0xd4, 0x9b,
        0x2e, 0x7c, 0xb5, 0x62, 0x92, 0x1b, 0xa3, 0x98, 0xea, 0x9b, 0xf8,
    ];
    const TLS_TEST_KEY: &[u8] = &[
        0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d,
        0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30,
        0x6b, 0x02, 0x01, 0x01, 0x04, 0x20, 0x48, 0x30, 0x4c, 0xf3, 0xb8, 0x0a, 0xde, 0xf6, 0x3c,
        0xf1, 0x43, 0x2b, 0x63, 0xd7, 0xdf, 0x5b, 0xa3, 0x00, 0xec, 0x79, 0xdf, 0x6a, 0xe7, 0x27,
        0x79, 0x56, 0x82, 0xd3, 0x58, 0xf7, 0x9e, 0xf8, 0xa1, 0x44, 0x03, 0x42, 0x00, 0x04, 0x85,
        0x02, 0x1b, 0xba, 0xb7, 0x6d, 0x42, 0xe6, 0xd7, 0xaf, 0xd9, 0xc1, 0xc3, 0xf2, 0xf2, 0x7a,
        0x98, 0xab, 0x54, 0xfb, 0x40, 0x69, 0x32, 0xa1, 0x7d, 0xfe, 0x89, 0x2c, 0xcb, 0x96, 0x0b,
        0x11, 0x60, 0x75, 0x2a, 0x0e, 0x5b, 0xd8, 0x63, 0x59, 0xf2, 0xa5, 0xc9, 0xf2, 0x7b, 0xa8,
        0xea, 0x38, 0x74, 0x68, 0x2f, 0x65, 0x36, 0xa8, 0xde, 0x40, 0xc7, 0xf9, 0x99, 0x9a, 0xfa,
        0x55, 0xc1, 0x99,
    ];

    #[test]
    fn validates_public_https_urls_and_fixed_search_endpoint() {
        for url in [
            "http://example.com",
            "file:///etc/passwd",
            "https://127.1/",
            "https://[::1]/",
            "https://example.com:444/",
            "https://user:pass@example.com/",
            "https://host.local/",
            "https://example.com./",
            "https://a\\b.com/",
        ] {
            assert!(public_url(url).is_err(), "{url}");
        }
        assert_eq!(
            public_url("https://example.com/page#fragment")
                .unwrap()
                .as_str(),
            "https://example.com/page"
        );
        let url = Url::parse(&search_url("test & + query").unwrap()).unwrap();
        assert_eq!(url.host_str(), Some("html.duckduckgo.com"));
        assert_eq!(url.query_pairs().next().unwrap().1, "test & + query");
        assert!(search_url(&"x".repeat(257)).is_err());
    }

    #[test]
    fn rejects_every_private_special_and_mixed_dns_answer() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "100.64.1.2",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fe80::1",
            "fc00::1",
            "2001:db8::1",
            "2001::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        let public: SocketAddr = "93.184.216.34:443".parse().unwrap();
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
        assert_eq!(checked_address([public]).unwrap(), public);
        assert!(checked_address([public, "127.0.0.1:443".parse().unwrap()]).is_err());
        assert!(checked_address([]).is_err());
    }

    #[test]
    fn rejects_redirects_non_text_compressed_and_oversized_bodies() {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            "text/plain; charset=utf-8".parse().unwrap(),
        );
        assert!(validate_response(StatusCode::OK, &headers).is_ok());
        assert!(validate_response(StatusCode::FOUND, &headers).is_err());
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        assert!(validate_response(StatusCode::OK, &headers).is_err());
        headers.insert(header::CONTENT_TYPE, "text/html".parse().unwrap());
        headers.insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        assert!(validate_response(StatusCode::OK, &headers).is_err());
        headers.remove(header::CONTENT_ENCODING);
        headers.insert(
            header::CONTENT_LENGTH,
            (MAX_BODY_BYTES + 1).to_string().parse().unwrap(),
        );
        assert!(validate_response(StatusCode::OK, &headers).is_err());
        let mut body = vec![0; MAX_BODY_BYTES - 1];
        append_body(&mut body, &[1]).unwrap();
        assert!(append_body(&mut body, &[1]).is_err());
        assert_eq!(body.len(), MAX_BODY_BYTES);
    }

    #[test]
    fn dns_pinning_preserves_certificate_and_hostname_verification() {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::Arc,
        };
        let server_config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(TLS_TEST_CERT.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(TLS_TEST_KEY.to_vec())),
        )
        .unwrap();
        let server_config = Arc::new(server_config);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            for _ in 0..4 {
                let deadline = Instant::now() + Duration::from_secs(5);
                let socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "TLS fixture did not receive its connection"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("TLS fixture failed: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let connection = rustls::ServerConnection::new(server_config.clone()).unwrap();
                let mut stream = rustls::StreamOwned::new(connection, socket);
                let mut request = [0; 4096];
                match stream.read(&mut request) {
                    Ok(length) => {
                        if length > 0 {
                            let response = if request[..length].starts_with(b"GET /redirect ") {
                                format!("HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1:{}/blocked\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", address.port())
                            } else {
                                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_owned()
                            };
                            let _ = stream.write_all(response.as_bytes());
                        }
                        let _ = stream.flush();
                    }
                    Err(_) => {}
                }
            }
        });
        tauri::async_runtime::block_on(async {
            let url = format!("https://research.example:{}/", address.port());
            let production = client_builder("research.example", address)
                .unwrap()
                .build()
                .unwrap();
            assert!(
                production.get(&url).send().await.is_err(),
                "self-signed server must not be trusted"
            );
            let fixture_root = || reqwest::Certificate::from_der(TLS_TEST_CERT).unwrap();
            let trusted = client_builder("research.example", address)
                .unwrap()
                .tls_certs_only([fixture_root()])
                .build()
                .unwrap();
            let response = trusted.get(&url).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.text().await.unwrap(), "ok");
            let redirect = trusted
                .get(format!(
                    "https://research.example:{}/redirect",
                    address.port()
                ))
                .send()
                .await
                .unwrap();
            assert_eq!(
                redirect.status(),
                StatusCode::FOUND,
                "private-address redirects must never be followed"
            );
            assert!(validate_response(redirect.status(), redirect.headers()).is_err());
            let wrong_host = client_builder("other.example", address)
                .unwrap()
                .tls_certs_only([fixture_root()])
                .build()
                .unwrap();
            assert!(
                wrong_host
                    .get(format!("https://other.example:{}/", address.port()))
                    .send()
                    .await
                    .is_err(),
                "pinned addresses must not bypass TLS hostname validation"
            );
        });
        worker.join().unwrap();
    }

    #[test]
    fn cancellation_interrupts_in_flight_work_and_drops_its_future() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = DropFlag(dropped.clone());
        let signal = cancelled.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            signal.store(true, Ordering::Release);
        });
        let result = tauri::async_runtime::block_on(bounded(
            async move {
                let _flag = flag;
                std::future::pending::<()>().await
            },
            Instant::now() + Duration::from_secs(2),
            &|| cancelled.load(Ordering::Acquire),
        ));
        worker.join().unwrap();
        assert_eq!(result.unwrap_err(), "Task cancelled.");
        assert!(dropped.load(Ordering::Acquire));
    }

    #[test]
    fn cancellation_and_deadline_drop_pending_work() {
        tauri::async_runtime::block_on(async {
            let future = std::future::pending::<()>();
            assert_eq!(
                bounded(future, Instant::now() + Duration::from_secs(1), &|| true)
                    .await
                    .unwrap_err(),
                "Task cancelled."
            );
            assert!(
                bounded(std::future::pending::<()>(), Instant::now(), &|| false)
                    .await
                    .unwrap_err()
                    .contains("timed out")
            );
        });
    }
}
