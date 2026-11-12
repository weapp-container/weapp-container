//! Session-local monotonic animation time. Guest timer timestamps never enter
//! this clock, and nested host calls share the outer turn's captured instant.

use super::Instant;
use std::cell::Cell;
use std::time::Duration;

pub(super) struct AnimationClock {
    origin: Instant,
    turn: Cell<Option<Duration>>,
    #[cfg(test)]
    controlled: Cell<Option<Duration>>,
}

impl Default for AnimationClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
            turn: Cell::new(None),
            #[cfg(test)]
            controlled: Cell::new(None),
        }
    }
}

impl AnimationClock {
    pub(super) fn now(&self) -> Duration {
        if let Some(time) = self.turn.get() {
            return time;
        }
        #[cfg(test)]
        if let Some(time) = self.controlled.get() {
            return time;
        }
        self.origin.elapsed()
    }

    /// Returns the enclosing turn, if any, for exact restoration on every
    /// normal/error completion. This value is never supplied by a guest.
    pub(super) fn begin_turn(&self) -> Option<Duration> {
        let previous = self.turn.get();
        if previous.is_none() {
            self.turn.set(Some(self.now()));
        }
        previous
    }

    pub(super) fn end_turn(&self, previous: Option<Duration>) {
        self.turn.set(previous);
    }

    /// Internal deterministic test clock; it cannot be reached through a
    /// bridge request, timer timestamp, SessionConfig, or WASM export.
    #[cfg(test)]
    pub(super) fn advance_to(&self, time: Duration) -> Result<(), &'static str> {
        if self.turn.get().is_some() {
            return Err("cannot advance animation time during a captured host turn");
        }
        if self.controlled.get().is_some_and(|current| time < current) {
            return Err("animation test time cannot move backwards");
        }
        self.controlled.set(Some(time));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_turns_keep_the_outer_sample_and_restore_the_clock() {
        let clock = AnimationClock::default();
        clock.advance_to(Duration::from_millis(13)).unwrap();
        let outer = clock.begin_turn();
        let nested = clock.begin_turn();
        assert_eq!(clock.now(), Duration::from_millis(13));
        assert!(clock.advance_to(Duration::from_secs(2)).is_err());
        clock.end_turn(nested);
        assert!(clock.advance_to(Duration::from_secs(2)).is_err());
        clock.end_turn(outer);
        clock.advance_to(Duration::from_secs(2)).unwrap();
        assert_eq!(clock.now(), Duration::from_secs(2));
        assert!(clock.advance_to(Duration::from_millis(13)).is_err());
        assert_eq!(clock.now(), Duration::from_secs(2));
    }
}
