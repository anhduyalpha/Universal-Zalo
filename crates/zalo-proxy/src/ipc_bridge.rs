use anyhow::Result;
use bytes::Bytes;
use tokio::sync::mpsc;

#[cfg(unix)]
use tokio::net::UnixListener;

pub struct IpcBridge;

impl IpcBridge {
    pub async fn start_stream_logger(mut rx: mpsc::Receiver<Bytes>) -> Result<()> {
        while let Some(raw_frame) = rx.recv().await {
            let preview_len = raw_frame.len().min(32);
            tracing::info!(
                total_len = raw_frame.len(),
                preview_hex = ?&raw_frame[..preview_len],
                "📦 [RAW PROTOBUF FRAME SNIFFED]"
            );
        }
        Ok(())
    }

    #[cfg(unix)]
    pub async fn start_unix_socket_relay(socket_path: &str, mut rx: mpsc::Receiver<Bytes>) -> Result<()> {
        let _ = std::fs::remove_file(socket_path);
        let listener = UnixListener::bind(socket_path)?;
        tracing::info!("IPC Unix Domain Socket active at: {}", socket_path);

        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                while let Some(frame) = rx.recv().await {
                    let len_prefix = (frame.len() as u32).to_be_bytes();
                    if stream.write_all(&len_prefix).await.is_err() {
                        break;
                    }
                    if stream.write_all(&frame).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(())
    }
}
