use dashmap::DashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct IdleSession {
    pub account_id: String,
    pub last_active: Instant,
    pub heartbeat_interval: Duration,
}

pub struct IdleSessionHub {
    sessions: Arc<DashMap<String, IdleSession>>,
    active_count: Arc<AtomicUsize>,
}

impl IdleSessionHub {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            active_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn register_idle_session(&self, account_id: String) {
        self.sessions.insert(
            account_id.clone(),
            IdleSession {
                account_id,
                last_active: Instant::now(),
                heartbeat_interval: Duration::from_secs(30),
            },
        );
        self.active_count.fetch_add(1, Ordering::SeqCst);
    }

    pub fn unregister_session(&self, account_id: &str) -> Option<IdleSession> {
        if let Some((_, session)) = self.sessions.remove(account_id) {
            self.active_count.fetch_sub(1, Ordering::SeqCst);
            Some(session)
        } else {
            None
        }
    }

    pub fn get_idle_count(&self) -> usize {
        self.active_count.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_idle_session_hub_lifecycle() {
        let hub = IdleSessionHub::new();
        assert_eq!(hub.get_idle_count(), 0);

        hub.register_idle_session("acc_1".into());
        hub.register_idle_session("acc_2".into());
        assert_eq!(hub.get_idle_count(), 2);

        hub.unregister_session("acc_1");
        assert_eq!(hub.get_idle_count(), 1);
    }
}
