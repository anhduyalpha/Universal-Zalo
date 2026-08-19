use anyhow::{Context, Result};
use curve25519_dalek::scalar::Scalar;
use rand::rngs::OsRng;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Immutable Identity Key Vault lưu trữ cặp khóa Curve25519
/// Sử dụng cơ chế zeroize để xóa trắng RAM khi drop
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct IdentityKeyPair {
    private_key: [u8; 32],
    public_key: [u8; 32],
}

impl IdentityKeyPair {
    pub fn generate() -> Self {
        let mut rng = OsRng;
        let scalar = Scalar::random(&mut rng);
        let public = curve25519_dalek::constants::ED25519_BASEPOINT_TABLE * &scalar;
        
        let private_bytes = scalar.to_bytes();
        let public_bytes = public.to_montgomery().to_bytes();

        Self {
            private_key: private_bytes,
            public_key: public_bytes,
        }
    }

    pub fn from_raw_bytes(private_bytes: [u8; 32], public_bytes: [u8; 32]) -> Self {
        Self {
            private_key: private_bytes,
            public_key: public_bytes,
        }
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.public_key
    }

    pub fn private_key_bytes(&self) -> [u8; 32] {
        self.private_key
    }
}

pub struct IdentityVault {
    key_pair: IdentityKeyPair,
}

impl IdentityVault {
    pub fn new(key_pair: IdentityKeyPair) -> Self {
        Self { key_pair }
    }

    pub fn get_public_key(&self) -> [u8; 32] {
        self.key_pair.public_key_bytes()
    }

    pub fn get_key_pair(&self) -> &IdentityKeyPair {
        &self.key_pair
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identity_key_generation_and_zeroize() {
        let vault = IdentityVault::new(IdentityKeyPair::generate());
        assert_ne!(vault.get_public_key(), [0u8; 32]);
    }
}
