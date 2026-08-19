use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub const TOTAL_VIRTUAL_SHARDS: usize = 256;

#[derive(Debug, Clone)]
pub struct VirtualShardManager {
    num_shards: usize,
}

impl VirtualShardManager {
    pub fn new() -> Self {
        Self {
            num_shards: TOTAL_VIRTUAL_SHARDS,
        }
    }

    pub fn get_shard_id(&self, conversation_id: &str) -> usize {
        let mut hasher = DefaultHasher::new();
        conversation_id.hash(&mut hasher);
        (hasher.finish() as usize) % self.num_shards
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_virtual_shard_distribution() {
        let manager = VirtualShardManager::new();
        let shard_1 = manager.get_shard_id("conv_alice_123");
        let shard_2 = manager.get_shard_id("conv_bob_456");

        assert!(shard_1 < 256);
        assert!(shard_2 < 256);
        assert_eq!(shard_1, manager.get_shard_id("conv_alice_123")); // Deterministic
    }
}
