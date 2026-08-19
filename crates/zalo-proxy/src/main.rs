mod cert;
mod ipc_bridge;
mod socks5;
mod ws_arbiter;

use anyhow::Result;
use cert::CertAuthority;
use clap::Parser;
use ipc_bridge::IpcBridge;
use socks5::{Socks5Handler, TargetAddr};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::TlsAcceptor;
use tracing_subscriber::EnvFilter;
use ws_arbiter::WsArbiter;

pub struct PrefixedStream<S> {
    prefix: std::io::Cursor<Vec<u8>>,
    inner: S,
}

impl<S> PrefixedStream<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix: std::io::Cursor::new(prefix),
            inner,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.prefix.position() < self.prefix.get_ref().len() as u64 {
            let pos = self.prefix.position() as usize;
            let slice = &self.prefix.get_ref()[pos..];
            let to_read = std::cmp::min(slice.len(), buf.remaining());
            buf.put_slice(&slice[..to_read]);
            self.prefix.set_position((pos + to_read) as u64);
            Poll::Ready(Ok(()))
        } else {
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[derive(Parser, Debug)]
#[command(author, version, about = "Zalo SOCKS5 MITM Loopback Proxy")]
pub struct Args {
    #[arg(short, long, default_value_t = 9050)]
    pub port: u16,

    #[arg(short, long, default_value = "./certs")]
    pub cert_dir: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("zalo_proxy=info".parse()?))
        .init();

    let args = Args::parse();
    let ca = Arc::new(CertAuthority::load_or_create(&args.cert_dir)?);

    let bind_addr: SocketAddr = format!("0.0.0.0:{}", args.port).parse()?;
    let listener = TcpListener::bind(bind_addr).await?;
    tracing::info!("🚀 Zalo SOCKS5 Loopback Proxy listening on {}", bind_addr);

    let (ipc_tx, ipc_rx) = tokio::sync::mpsc::channel(1024);

    // Tiến trình in log nhị phân ra Terminal
    tokio::spawn(async move {
        let _ = IpcBridge::start_stream_logger(ipc_rx).await;
    });

    while let Ok((mut client_stream, peer_addr)) = listener.accept().await {
        let ca = Arc::clone(&ca);
        let ipc_tx = ipc_tx.clone();

        tokio::spawn(async move {
            let target = match Socks5Handler::handshake(&mut client_stream).await {
                Ok(t) => t,
                Err(e) => {
                    tracing::debug!("Handshake failed for {}: {:?}", peer_addr, e);
                    return;
                }
            };

            let (target_host, target_port) = match &target {
                TargetAddr::Domain(d, p) => (d.clone(), *p),
                TargetAddr::Ip(addr) => (addr.ip().to_string(), addr.port()),
            };

            tracing::info!("Connecting target {}:{}", target_host, target_port);

            let mut target_stream = match TcpStream::connect(format!("{}:{}", target_host, target_port)).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("Failed to connect to target {}:{}: {:?}", target_host, target_port, e);
                    return;
                }
            };

            // MITM TLS & WebSocket Sniffing chỉ áp dụng cho zalo.me HTTPS (port 443)
            if target_host.contains("zalo.me") && target_port == 443 {
                if let Ok(server_config) = ca.generate_server_config(&target_host) {
                    let acceptor = TlsAcceptor::from(server_config);
                    if let Ok(mut tls_client) = acceptor.accept(client_stream).await {
                        let mut root_store = tokio_rustls::rustls::RootCertStore::empty();
                        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

                        let client_config = tokio_rustls::rustls::ClientConfig::builder()
                            .with_root_certificates(root_store)
                            .with_no_client_auth();
                        let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config));

                        if let Ok(server_name) = ServerName::try_from(target_host.as_str()) {
                            if let Ok(mut tls_server) = connector.connect(server_name.to_owned(), target_stream).await {
                                // Đọc phần đầu của HTTP request để phân biệt WebSocket vs Regular HTTPS
                                let mut initial_buf = [0u8; 4096];
                                if let Ok(n) = tls_client.read(&mut initial_buf).await {
                                    if n > 0 {
                                        let req_str = String::from_utf8_lossy(&initial_buf[..n]);
                                        let is_websocket = req_str.to_ascii_lowercase().contains("upgrade: websocket");

                                        if is_websocket {
                                            let prefixed_client = PrefixedStream::new(initial_buf[..n].to_vec(), tls_client);
                                            if let (Ok(client_ws), Ok(server_ws)) = (
                                                tokio_tungstenite::accept_async(prefixed_client).await,
                                                tokio_tungstenite::client_async(
                                                    format!("wss://{}/ws/", target_host),
                                                    tls_server,
                                                )
                                                .await,
                                            ) {
                                                let _ = WsArbiter::intercept_stream(
                                                    client_ws,
                                                    server_ws.0,
                                                    ipc_tx,
                                                )
                                                .await;
                                                return;
                                            }
                                        } else {
                                            // Regular HTTPS: gửi header ban đầu sang server và relay 2 chiều
                                            if tls_server.write_all(&initial_buf[..n]).await.is_ok() && tls_server.flush().await.is_ok() {
                                                let _ = tokio::io::copy_bidirectional(&mut tls_client, &mut tls_server).await;
                                                return;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    return;
                }
            }

            // Mọi traffic thông thường khác (TCP Relay trong suốt)
            let _ = tokio::io::copy_bidirectional(&mut client_stream, &mut target_stream).await;
        });
    }

    Ok(())
}
