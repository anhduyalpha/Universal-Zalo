use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacketOrigin {
    Browser,
    SubClient { client_id: String, idempotency_key: String },
}

#[derive(Debug, Clone)]
pub struct PendingRequest {
    pub origin: PacketOrigin,
    pub created_at: Instant,
    pub original_browser_seq: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct AckRouter {
    pending_table: Arc<DashMap<u32, PendingRequest>>,
}

impl AckRouter {
    pub fn new() -> Self {
        Self {
            pending_table: Arc::new(DashMap::new()),
        }
    }

    pub fn register_request(&self, wire_seq: u32, origin: PacketOrigin, original_browser_seq: Option<u32>) {
        self.pending_table.insert(
            wire_seq,
            PendingRequest {
                origin,
                created_at: Instant::now(),
                original_browser_seq,
            },
        );
    }

    pub fn resolve_ack(&self, wire_seq: u32) -> Option<PendingRequest> {
        self.pending_table.remove(&wire_seq).map(|(_, req)| req)
    }

    pub fn cleanup_stale_requests(&self, timeout: Duration) {
        let now = Instant::now();
        self.pending_table.retain(|_, req| now.duration_since(req.created_at) < timeout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ack_router_routing() {
        let router = AckRouter::new();

        router.register_request(101, PacketOrigin::Browser, Some(99));
        router.register_request(
            102,
            PacketOrigin::SubClient {
                client_id: "client-laptop".into(),
                idempotency_key: "ik-123".into(),
            },
            None,
        );

        // Resolve 101 -> Browser
        let req_101 = router.resolve_ack(101).unwrap();
        assert_eq!(req_101.origin, PacketOrigin::Browser);
        assert_eq!(req_101.original_browser_seq, Some(99));

        // Resolve 102 -> SubClient
        let req_102 = router.resolve_ack(102).unwrap();
        match req_102.origin {
            PacketOrigin::SubClient { client_id, idempotency_key } => {
                assert_eq!(client_id, "client-laptop");
                assert_eq!(idempotency_key, "ik-123");
            }
            _ => panic!("Expected SubClient origin"),
        }

        // 103 không tồn tại
        assert!(router.resolve_ack(103).is_none());
    }
}
