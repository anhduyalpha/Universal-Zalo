use rand::rngs::OsRng;
use x25519_dalek::{PublicKey, StaticSecret};

pub struct IdentityKeyPair {
    pub secret: StaticSecret,
    pub public: PublicKey,
}

impl IdentityKeyPair {
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        let secret = StaticSecret::from(bytes);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        *self.public.as_bytes()
    }

    pub fn private_key_bytes(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }

    pub fn diffie_hellman(&self, their_public: &[u8; 32]) -> [u8; 32] {
        let their_point = PublicKey::from(*their_public);
        *self.secret.diffie_hellman(&their_point).as_bytes()
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
    fn test_identity_key_generation() {
        let vault = IdentityVault::new(IdentityKeyPair::generate());
        assert_ne!(vault.get_public_key(), [0u8; 32]);
    }
}
