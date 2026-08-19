use anyhow::Result;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub struct WsArbiter;

impl WsArbiter {
    pub async fn intercept_stream<S1, S2>(
        client_ws: WebSocketStream<S1>,
        server_ws: WebSocketStream<S2>,
        ipc_tx: mpsc::Sender<Bytes>,
    ) -> Result<()>
    where
        S1: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
        S2: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (mut client_write, mut client_read) = client_ws.split();
        let (mut server_write, mut server_read) = server_ws.split();

        let (_outbound_tx, mut outbound_rx) = mpsc::channel::<Message>(256);
        let ipc_tx_inbound = ipc_tx.clone();

        // 1. Luồng Downstream: Zalo Cloud -> Browser (Sniff Inbound)
        let downstream_task = tokio::spawn(async move {
            while let Some(msg_res) = server_read.next().await {
                match msg_res {
                    Ok(msg) => {
                        if let Message::Binary(ref bin) = msg {
                            tracing::info!(len = bin.len(), "INBOUND WebSocket Frame captured");
                            let _ = ipc_tx_inbound.send(Bytes::copy_from_slice(bin)).await;
                        }
                        if client_write.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Server WS read error: {:?}", e);
                        break;
                    }
                }
            }
        });

        // 2. Luồng Upstream: Browser & Injected Frames -> Zalo Cloud (Sniff Outbound)
        let upstream_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(client_msg) = client_read.next() => {
                        match client_msg {
                            Ok(msg) => {
                                if let Message::Binary(ref bin) = msg {
                                    tracing::info!(len = bin.len(), "OUTBOUND (Browser) WebSocket Frame captured");
                                    let _ = ipc_tx.send(Bytes::copy_from_slice(bin)).await;
                                }
                                if server_write.send(msg).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    Some(injected_msg) = outbound_rx.recv() => {
                        if server_write.send(injected_msg).await.is_err() {
                            break;
                        }
                    }
                    else => break,
                }
            }
        });

        let _ = tokio::try_join!(downstream_task, upstream_task);
        Ok(())
    }
}
