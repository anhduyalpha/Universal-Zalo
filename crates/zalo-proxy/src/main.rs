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
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::TlsAcceptor;
use tracing_subscriber::EnvFilter;
use ws_arbiter::WsArbiter;

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
            match Socks5Handler::handshake(&mut client_stream).await {
                Ok(target) => match target {
                    TargetAddr::Domain(domain, port) => {
                        tracing::info!("Target request: {}:{}", domain, port);
                        if domain.contains("zalo.me") && port == 443 {
                            if let Ok(server_config) = ca.generate_server_config(&domain) {
                                let acceptor = TlsAcceptor::from(server_config);
                                if let Ok(tls_client) = acceptor.accept(client_stream).await {
                                    if let Ok(target_stream) =
                                        TcpStream::connect(format!("{}:{}", domain, port)).await
                                    {
                                        let mut root_store =
                                            tokio_rustls::rustls::RootCertStore::empty();
                                        root_store.extend(
                                            webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
                                        );

                                        let client_config =
                                            tokio_rustls::rustls::ClientConfig::builder()
                                                .with_root_certificates(root_store)
                                                .with_no_client_auth();
                                        let connector =
                                            tokio_rustls::TlsConnector::from(Arc::new(client_config));

                                        if let Ok(server_name) =
                                            ServerName::try_from(domain.as_str())
                                        {
                                            if let Ok(tls_server) = connector
                                                .connect(server_name.to_owned(), target_stream)
                                                .await
                                            {
                                                if let (Ok(client_ws), Ok(server_ws)) = (
                                                    tokio_tungstenite::accept_async(tls_client).await,
                                                    tokio_tungstenite::client_async(
                                                        format!("wss://{}/ws/", domain),
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
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    TargetAddr::Ip(_) => {}
                },
                Err(e) => tracing::debug!("Handshake failed for {}: {:?}", peer_addr, e),
            }
        });
    }

    Ok(())
}
