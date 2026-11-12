//! The latest evaluated document for each concrete page/component occurrence.
//!
//! A graph-discovery pass may revisit a scope without representing a new View
//! update. Keep successful and failed evaluations alike until its input changes;
//! replaying either would repeat stateful View code once an isolated engine is
//! connected. This cache does not make execution or lifecycle effects atomic.

use crate::animation_bindings::ScopeSnapshot;
use container_bridge::{BridgeError, BridgeErrorCode};
use container_ir::{EvaluatedWxml, WxmlAst, WxmlAttributeSource};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RenderTicket {
    scope: String,
    document: String,
    generation: u64,
    revision: u64,
    attempt: u64,
}

#[derive(Clone, Debug)]
struct ScopeWork {
    document: String,
    data: Value,
    revision: u64,
    attempt: u64,
    result: Option<Result<WxmlAst, BridgeError>>,
}

#[derive(Clone, Debug)]
pub(crate) enum RenderRead {
    Ready(Result<WxmlAst, BridgeError>),
    Pending(RenderTicket),
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RenderWork {
    fingerprint: Option<String>,
    generation: u64,
    next_attempt: u64,
    scopes: BTreeMap<String, ScopeWork>,
    attribute_sources: BTreeMap<String, Vec<WxmlAttributeSource>>,
    input_snapshots: BTreeMap<String, Arc<ScopeSnapshot>>,
    #[cfg(test)]
    completed_evaluations: u64,
}

impl RenderWork {
    /// Called once at an operation boundary, never for every discovery round.
    /// Styles/assets are not executable inputs and must not enter this digest.
    pub(crate) fn begin_program(&mut self, fingerprint: String) {
        if self.fingerprint.as_ref() != Some(&fingerprint) {
            self.generation = self.generation.saturating_add(1);
            self.fingerprint = Some(fingerprint);
            self.scopes.clear();
            self.attribute_sources.clear();
            // The root snapshot may have just been captured with this input;
            // a program refresh invalidates AST/sources, not that data clone.
        }
    }

    /// Clone-time input provenance is updated even when equal data reuses AST.
    /// Call before `read`; repeated cache reads must never sample a newer ledger.
    pub(crate) fn set_input_snapshot(&mut self, scope: &str, snapshot: Arc<ScopeSnapshot>) {
        self.input_snapshots.insert(scope.into(), snapshot);
    }
    pub(crate) fn input_snapshot(&self, scope: &str) -> Option<Arc<ScopeSnapshot>> {
        self.input_snapshots.get(scope).cloned()
    }
    pub(crate) fn attribute_sources(&self, scope: &str) -> &[WxmlAttributeSource] {
        self.attribute_sources
            .get(scope)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub(crate) fn commit_batch_with_sources(
        &mut self,
        results: Vec<(RenderTicket, Result<EvaluatedWxml, BridgeError>)>,
    ) -> Result<(), BridgeError> {
        let sources = results
            .iter()
            .filter_map(|(ticket, result)| {
                result
                    .as_ref()
                    .ok()
                    .map(|result| (ticket.scope.clone(), result.attribute_sources.clone()))
            })
            .collect::<Vec<_>>();
        self.commit_batch(
            results
                .into_iter()
                .map(|(ticket, result)| (ticket, result.map(|result| result.ast)))
                .collect(),
        )?;
        for (scope, source) in sources {
            self.attribute_sources.insert(scope, source);
        }
        Ok(())
    }

    /// Reserve the current input. Repeated reads return the same ticket so a
    /// future frontier renderer can deduplicate a batch before executing it.
    pub(crate) fn read(&mut self, scope: &str, document: &str, data: &Value) -> RenderRead {
        let changed = self
            .scopes
            .get(scope)
            .is_none_or(|entry| entry.document != document || entry.data != *data);
        if changed {
            let revision = self
                .scopes
                .get(scope)
                .map_or(1, |entry| entry.revision.saturating_add(1));
            self.next_attempt = self.next_attempt.saturating_add(1);
            self.scopes.insert(
                scope.into(),
                ScopeWork {
                    document: document.into(),
                    data: data.clone(),
                    revision,
                    attempt: self.next_attempt,
                    result: None,
                },
            );
        }
        let entry = self.scopes.get(scope).expect("reserved render input");
        if let Some(result) = &entry.result {
            return RenderRead::Ready(result.clone());
        }
        RenderRead::Pending(RenderTicket {
            scope: scope.into(),
            document: document.into(),
            generation: self.generation,
            revision: entry.revision,
            attempt: entry.attempt,
        })
    }

    /// Only the still-current, uncommitted reservation may publish its result.
    /// Input changes, program changes and scope retirement reject stale work.
    pub(crate) fn commit(
        &mut self,
        ticket: RenderTicket,
        result: Result<WxmlAst, BridgeError>,
    ) -> Result<(), BridgeError> {
        let current = self.scopes.get_mut(&ticket.scope).filter(|entry| {
            ticket.generation == self.generation
                && ticket.document == entry.document
                && ticket.revision == entry.revision
                && ticket.attempt == entry.attempt
                && entry.result.is_none()
        });
        let Some(entry) = current else {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "stale or already committed View render ticket",
            ));
        };
        entry.result = Some(result);
        #[cfg(test)]
        {
            self.completed_evaluations += 1;
        }
        Ok(())
    }

    /// Validate every reservation before publishing any member of a native
    /// batch. A stale member cannot leave an otherwise partial cache commit.
    pub(crate) fn commit_batch(
        &mut self,
        results: Vec<(RenderTicket, Result<WxmlAst, BridgeError>)>,
    ) -> Result<(), BridgeError> {
        let mut scopes = BTreeSet::new();
        if results.iter().any(|(ticket, _)| {
            !scopes.insert(ticket.scope.clone())
                || self.scopes.get(&ticket.scope).is_none_or(|entry| {
                    ticket.generation != self.generation
                        || ticket.document != entry.document
                        || ticket.revision != entry.revision
                        || ticket.attempt != entry.attempt
                        || entry.result.is_some()
                })
        }) {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "stale, duplicate or already committed View render batch",
            ));
        }
        for (ticket, result) in results {
            self.commit(ticket, result)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn evaluate(
        &mut self,
        scope: &str,
        document: &str,
        data: &Value,
        evaluate: impl FnOnce() -> Result<WxmlAst, BridgeError>,
    ) -> Result<WxmlAst, BridgeError> {
        match self.read(scope, document, data) {
            RenderRead::Ready(result) => result,
            RenderRead::Pending(ticket) => {
                let result = evaluate();
                self.commit(ticket, result.clone())?;
                result
            }
        }
    }

    pub(crate) fn release_scopes(&mut self, scopes: &[String]) {
        for scope in scopes {
            self.scopes.remove(scope);
            self.attribute_sources.remove(scope);
            self.input_snapshots.remove(scope);
        }
    }

    pub(crate) fn retain_scopes(&mut self, scopes: &BTreeSet<String>) {
        self.scopes.retain(|scope, _| scopes.contains(scope));
        self.attribute_sources
            .retain(|scope, _| scopes.contains(scope));
        self.input_snapshots
            .retain(|scope, _| scopes.contains(scope));
    }

    /// Explicit retries are distinct attempts; ordinary idle/discovery reads
    /// deliberately keep a failed result. Native View recovery will call this
    /// only after its own realm/error policy permits another execution.
    #[allow(dead_code)]
    pub(crate) fn retry_scope(&mut self, scope: &str) {
        if let Some(entry) = self.scopes.get_mut(scope) {
            self.next_attempt = self.next_attempt.saturating_add(1);
            entry.attempt = self.next_attempt;
            entry.result = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn completed_evaluations(&self) -> u64 {
        self.completed_evaluations
    }

    pub(crate) fn scope_ids(&self) -> BTreeSet<String> {
        self.scopes.keys().cloned().collect()
    }

    pub(crate) fn input_epoch(&self, scope: &str) -> (u64, Option<(u64, u64)>) {
        (
            self.generation,
            self.scopes
                .get(scope)
                .map(|work| (work.revision, work.attempt)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::parse_wxml;
    use serde_json::json;

    fn ast(text: &str) -> WxmlAst {
        parse_wxml(&format!("<text>{text}</text>")).unwrap()
    }

    #[test]
    fn repeated_discovery_reuses_one_result_but_a_b_a_are_three_updates() {
        let mut work = RenderWork::default();
        work.begin_program("program".into());
        let mut executions = 0;
        for (data, expected) in [("a", 1), ("a", 1), ("b", 2), ("a", 3), ("a", 3)] {
            let output = work
                .evaluate("page:1/component:child", "child.wxml", &json!(data), || {
                    executions += 1;
                    Ok(ast(&executions.to_string()))
                })
                .unwrap();
            assert_eq!(executions, expected);
            assert_eq!(output, ast(&expected.to_string()));
        }
        assert_eq!(work.scopes["page:1/component:child"].revision, 3);
        assert_eq!(work.scopes.len(), 1);
    }

    #[test]
    fn failed_input_is_not_replayed_until_changed_or_explicitly_retried() {
        let mut work = RenderWork::default();
        work.begin_program("program".into());
        let failure = BridgeError::new(BridgeErrorCode::Render, "fixture evaluation failed");
        assert_eq!(
            work.evaluate("page:1", "page.wxml", &json!({}), || Err(failure.clone())),
            Err(failure.clone())
        );
        assert_eq!(
            work.evaluate("page:1", "page.wxml", &json!({}), || panic!(
                "replayed failure"
            )),
            Err(failure)
        );
        work.retry_scope("page:1");
        assert_eq!(
            work.evaluate("page:1", "page.wxml", &json!({}), || Ok(ast("recovered")))
                .unwrap(),
            ast("recovered")
        );
        work.evaluate("page:1", "page.wxml", &json!({"changed":true}), || {
            Ok(ast("changed"))
        })
        .unwrap();
    }

    #[test]
    fn stale_tickets_cannot_replace_new_inputs_or_recreated_scopes() {
        let mut work = RenderWork::default();
        work.begin_program("program".into());
        let RenderRead::Pending(first) = work.read("page:1", "page.wxml", &json!("a")) else {
            panic!("initial input must reserve work");
        };
        let RenderRead::Pending(same) = work.read("page:1", "page.wxml", &json!("a")) else {
            panic!("uncommitted input remains pending");
        };
        assert_eq!(first, same);
        work.read("page:1", "page.wxml", &json!("b"));
        assert!(work.commit(first.clone(), Ok(ast("stale"))).is_err());
        work.release_scopes(&["page:1".into()]);
        work.read("page:1", "page.wxml", &json!("a"));
        assert!(work.commit(first, Ok(ast("retired"))).is_err());
    }

    #[test]
    fn candidate_program_and_scope_updates_leave_live_results_untouched() {
        let mut live = RenderWork::default();
        live.begin_program("program-a".into());
        live.evaluate("page:1", "page.wxml", &json!({}), || Ok(ast("live")))
            .unwrap();
        let mut candidate = live.clone();
        candidate.begin_program("program-b".into());
        candidate
            .evaluate("page:1", "page.wxml", &json!({}), || Ok(ast("candidate")))
            .unwrap();
        assert_eq!(
            live.evaluate("page:1", "page.wxml", &json!({}), || panic!(
                "live reevaluated"
            ))
            .unwrap(),
            ast("live")
        );
        live.begin_program("program-a".into());
        assert!(matches!(
            live.read("page:1", "page.wxml", &json!({})),
            RenderRead::Ready(_)
        ));
        live.begin_program("program-b".into());
        assert!(matches!(
            live.read("page:1", "page.wxml", &json!({})),
            RenderRead::Pending(_)
        ));
    }

    #[test]
    fn a_stale_batch_member_cannot_publish_other_current_members() {
        let mut work = RenderWork::default();
        work.begin_program("program".into());
        let RenderRead::Pending(first) = work.read("first", "page.wxml", &json!(1)) else {
            panic!("first task must be pending");
        };
        let RenderRead::Pending(second) = work.read("second", "page.wxml", &json!(1)) else {
            panic!("second task must be pending");
        };
        work.read("second", "page.wxml", &json!(2));
        assert!(work
            .commit_batch(vec![(first, Ok(ast("first"))), (second, Ok(ast("stale"))),])
            .is_err());
        assert!(matches!(
            work.read("first", "page.wxml", &json!(1)),
            RenderRead::Pending(_)
        ));
        assert_eq!(work.completed_evaluations(), 0);
    }

    #[test]
    fn a_failed_batch_is_retained_for_every_reserved_task() {
        let mut work = RenderWork::default();
        work.begin_program("program".into());
        let mut pending = Vec::new();
        let error = BridgeError::new(BridgeErrorCode::Render, "late task failed");
        for scope in ["first", "second"] {
            let RenderRead::Pending(ticket) = work.read(scope, "page.wxml", &json!({})) else {
                panic!("initial task must be pending");
            };
            pending.push((ticket, Err(error.clone())));
        }
        work.commit_batch(pending).unwrap();
        for scope in ["first", "second"] {
            assert!(
                matches!(work.read(scope, "page.wxml", &json!({})), RenderRead::Ready(Err(failure)) if failure == error)
            );
        }
        assert_eq!(work.completed_evaluations(), 2);
    }
}
