use anyhow::{bail, Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetAddr {
    Domain(String, u16),
    Ip(std::net::SocketAddr),
}

pub struct Socks5Handler;

impl Socks5Handler {
    pub async fn handshake<S>(stream: &mut S) -> Result<TargetAddr>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let mut header = [0u8; 2];
        stream.read_exact(&mut header).await.context("Failed to read SOCKS5 version header")?;

        if header[0] != 0x05 {
            bail!("Unsupported SOCKS version: {}", header[0]);
        }

        let nmethods = header[1] as usize;
        let mut methods = vec![0u8; nmethods];
        stream.read_exact(&mut methods).await.context("Failed to read SOCKS5 auth methods")?;

        // 0x00: NO AUTHENTICATION REQUIRED
        stream.write_all(&[0x05, 0x00]).await.context("Failed to write SOCKS5 auth selection")?;
        stream.flush().await?;

        let mut req_header = [0u8; 4];
        stream.read_exact(&mut req_header).await.context("Failed to read SOCKS5 request header")?;

        if req_header[0] != 0x05 || req_header[1] != 0x01 {
            bail!("Only SOCKS5 CONNECT (0x01) command is supported, received: {:?}", req_header);
        }

        let target_addr = match req_header[3] {
            0x01 => {
                let mut ip = [0u8; 4];
                stream.read_exact(&mut ip).await?;
                let mut port = [0u8; 2];
                stream.read_exact(&mut port).await?;
                let socket_addr = std::net::SocketAddr::new(
                    std::net::IpAddr::V4(std::net::Ipv4Addr::from(ip)),
                    u16::from_be_bytes(port),
                );
                TargetAddr::Ip(socket_addr)
            }
            0x03 => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len).await?;
                let mut domain = vec![0u8; len[0] as usize];
                stream.read_exact(&mut domain).await?;
                let mut port = [0u8; 2];
                stream.read_exact(&mut port).await?;
                let domain_str = String::from_utf8(domain).context("Invalid UTF-8 domain in SOCKS5 request")?;
                TargetAddr::Domain(domain_str, u16::from_be_bytes(port))
            }
            0x04 => bail!("IPv6 SOCKS5 address not currently enabled"),
            _ => bail!("Unknown ATYP: {}", req_header[3]),
        };

        // Gửi ACK SOCKS5 SUCCESS (0x00)
        stream
            .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await
            .context("Failed to send SOCKS5 success reply")?;
        stream.flush().await?;

        Ok(target_addr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_test::io::Builder;

    #[tokio::test]
    async fn test_socks5_domain_handshake() {
        let mut mock_stream = Builder::new()
            .read(&[0x05, 0x01, 0x00]) // Client greeting: SOCKS5, 1 method (No auth)
            .write(&[0x05, 0x00])      // Server response: SOCKS5, No auth chosen
            .read(&[
                0x05, 0x01, 0x00, 0x03, // CONNECT, RSVD, Domain type
                12,                     // Length = 12
                b'c', b'h', b'a', b't', b'.', b'z', b'a', b'l', b'o', b'.', b'm', b'e',
                0x01, 0xBB,             // Port 443
            ])
            .write(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]) // Server reply: Success
            .build();

        let target = Socks5Handler::handshake(&mut mock_stream).await.unwrap();
        assert_eq!(target, TargetAddr::Domain("chat.zalo.me".to_string(), 443));
    }
}
