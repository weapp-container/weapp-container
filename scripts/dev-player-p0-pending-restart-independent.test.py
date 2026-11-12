import copy, importlib.util, json, sys, unittest
from pathlib import Path
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('author_pending', Path(__file__).with_name('dev-player-p0-pending-restart.test.py'))
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)

class FinalRestartBinding(unittest.TestCase):
    def run_case(self, result):
        harness = a.PendingRestart()
        item, clock = harness.harness([a.pending(), result, result, result])
        return harness.run_wait(item, clock, restart_after=a.fault_context())

    def test_foreign_coherent_owner_must_not_finish_the_known_pending_attempt(self):
        result = a.healthy(); state = result['snapshot']['state']
        state['ownerId'] = '18'; state['hostSurface']['ownerId'] = '18'; state['acceptedLayout']['ownerId'] = '18'
        with self.assertRaises(RuntimeError): self.run_case(result)

    def test_foreign_coherent_root_must_not_finish_the_known_pending_attempt(self):
        result = a.healthy(); result['snapshot']['state']['acceptedPackIdentity']['root'] = 'b' * 64; result['snapshot']['acceptedPack']['root'] = 'b' * 64
        with self.assertRaises(RuntimeError): self.run_case(result)

    def test_failed_terminal_receipt_must_not_be_covered_by_a_healthy_frame(self):
        result = a.healthy(); attempt = a.pending()['snapshot']['developmentAttempt']; attempt['resolution'] = 'terminal'; attempt['receipt']['status'] = 'rejected'
        result['snapshot']['developmentAttempt'] = attempt
        with self.assertRaises(RuntimeError): self.run_case(result)

    def test_unknown_or_failed_operation_cannot_be_hidden_by_the_old_faulted_frame(self):
        for resolution, status in [('unknown', 'applying'), ('terminal', 'rejected'), ('terminal', 'cancelled')]:
            result = a.fault_context()
            attempt = a.pending()['snapshot']['developmentAttempt']
            attempt.update(resolution=resolution, source='event')
            attempt['receipt']['status'] = status
            result['snapshot']['developmentAttempt'] = attempt
            harness = a.PendingRestart(); item, clock = harness.harness([result, a.healthy(), a.healthy(), a.healthy()])
            with self.subTest(status=status), self.assertRaises(RuntimeError): harness.run_wait(item, clock, restart_after=a.fault_context())

    def test_terminal_receipt_must_match_the_observed_pending_attempt(self):
        result = a.healthy(); result['snapshot']['developmentAttempt']['receipt']['attemptId'] = '7'
        with self.assertRaises(RuntimeError): self.run_case(result)

    def test_missing_terminal_receipt_is_not_recovery_authority(self):
        result = a.healthy(); result['snapshot'].pop('developmentAttempt')
        with self.assertRaises(RuntimeError): self.run_case(result)

    def test_valid_direct_terminal_restart_without_observed_pending_still_requires_independent_reads(self):
        harness = a.PendingRestart(); item, clock = harness.harness([a.healthy(), a.healthy(), a.healthy()])
        result = harness.run_wait(item, clock, restart_after=a.fault_context())
        self.assertEqual(result['snapshot']['state']['sessionId'], 'session-two')
        self.assertEqual(item.native_reads, [2])

    def test_old_faulted_frame_can_wait_before_the_exact_new_attempt_begins(self):
        old = a.fault_context(); old['requestId'] = 'new-read-of-old-fault'
        harness = a.PendingRestart(); item, clock = harness.harness([old, a.pending(), a.healthy(), a.healthy(), a.healthy()])
        result = harness.run_wait(item, clock, restart_after=a.fault_context())
        self.assertEqual(result['snapshot']['state']['sessionId'], 'session-two')
        self.assertEqual(item.native_reads, [4])

    def test_final_inspection_crossing_original_deadline_cannot_finish(self):
        harness = a.PendingRestart(); item, clock = harness.harness([a.pending(), a.healthy(), a.healthy(), a.healthy()])
        original = item.inspection; calls = 0
        def slow_final():
            nonlocal calls
            calls += 1
            value = original()
            if calls == 4: clock.now += 15
            return value
        item.inspection = slow_final
        with self.assertRaisesRegex(RuntimeError, 'original fifteen second deadline'): harness.run_wait(item, clock, restart_after=a.fault_context())

    def test_final_native_measurement_cannot_return_success_after_the_original_deadline(self):
        harness = a.PendingRestart(); item, clock = harness.harness([a.pending(), a.healthy(), a.healthy(), a.healthy()])
        original = item.observe_native_geometry
        def slow_observation(result):
            original(result); clock.now += 15
        item.observe_native_geometry = slow_observation
        with self.assertRaises(RuntimeError): harness.run_wait(item, clock, restart_after=a.fault_context())

if __name__ == '__main__': unittest.main()
