use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Result};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RatchetState {
    pub root_key: [u8; 32],
    pub send_chain_key: [u8; 32],
    pub recv_chain_key: [u8; 32],
    pub send_msg_index: u32,
    pub recv_msg_index: u32,
    pub skipped_keys: HashMap<String, [u8; 32]>,
}

impl RatchetState {
    pub fn new(shared_root_key: [u8; 32]) -> Self {
        Self {
            root_key: shared_root_key,
            send_chain_key: shared_root_key,
            recv_chain_key: shared_root_key,
            send_msg_index: 0,
            recv_msg_index: 0,
            skipped_keys: HashMap::new(),
        }
    }

    fn kdf_ck(chain_key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
        let mut mac = HmacSha256::new_from_slice(chain_key).expect("HMAC can take key of any size");
        mac.update(&[0x01]);
        let mut next_chain_key = [0u8; 32];
        next_chain_key.copy_from_slice(&mac.finalize().into_bytes());

        let mut mac2 = HmacSha256::new_from_slice(chain_key).expect("HMAC can take key of any size");
        mac2.update(&[0x02]);
        let mut message_key = [0u8; 32];
        message_key.copy_from_slice(&mac2.finalize().into_bytes());

        (next_chain_key, message_key)
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(u32, Vec<u8>)> {
        let (next_ck, msg_key) = Self::kdf_ck(&self.send_chain_key);
        self.send_chain_key = next_ck;
        let index = self.send_msg_index;
        self.send_msg_index += 1;

        let cipher = Aes256Gcm::new_from_slice(&msg_key)?;
        let nonce_bytes = [0u8; 12]; // In production derived from sequence counter
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher.encrypt(nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("AES-GCM encryption error: {:?}", e))?;

        Ok((index, ciphertext))
    }

    pub fn decrypt(&mut self, index: u32, ciphertext: &[u8]) -> Result<Vec<u8>> {
        // Handle skipped keys if message arrives late
        let msg_key = if let Some(key) = self.skipped_keys.remove(&index.to_string()) {
            key
        } else {
            while self.recv_msg_index < index {
                let (next_ck, skipped_mk) = Self::kdf_ck(&self.recv_chain_key);
                self.recv_chain_key = next_ck;
                self.skipped_keys.insert(self.recv_msg_index.to_string(), skipped_mk);
                self.recv_msg_index += 1;
            }
            let (next_ck, mk) = Self::kdf_ck(&self.recv_chain_key);
            self.recv_chain_key = next_ck;
            self.recv_msg_index += 1;
            mk
        };

        let cipher = Aes256Gcm::new_from_slice(&msg_key)?;
        let nonce_bytes = [0u8; 12];
        let nonce = Nonce::from_slice(&nonce_bytes);
        let plaintext = cipher.decrypt(nonce, ciphertext)
            .map_err(|e| anyhow::anyhow!("AES-GCM decryption error: {:?}", e))?;

        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_double_ratchet_symmetric_encryption_decryption() {
        let root_key = [42u8; 32];
        let mut alice = RatchetState::new(root_key);
        let mut bob = RatchetState::new(root_key);

        let msg1 = b"Hello from Alice over Double Ratchet!";
        let (idx1, ct1) = alice.encrypt(msg1).unwrap();
        assert_eq!(idx1, 0);

        let pt1 = bob.decrypt(idx1, &ct1).unwrap();
        assert_eq!(pt1, msg1);

        // Test out of order with skipped key
        let msg2 = b"Message 2 (will be skipped)";
        let msg3 = b"Message 3 (received first)";

        let (idx2, ct2) = alice.encrypt(msg2).unwrap();
        let (idx3, ct3) = alice.encrypt(msg3).unwrap();

        // Bob nhận message 3 trước
        let pt3 = bob.decrypt(idx3, &ct3).unwrap();
        assert_eq!(pt3, msg3);

        // Sau đó Bob nhận message 2
        let pt2 = bob.decrypt(idx2, &ct2).unwrap();
        assert_eq!(pt2, msg2);
    }
}
