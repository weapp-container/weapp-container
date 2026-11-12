// Shared by the native QuickJS and V8 adapters. The host driver performs a
// native microtask checkpoint between task() calls; JavaScript must never
// loop over timer callbacks inside a single engine call.
(function() {
  let reportError = typeof globalThis.__container_report_error === "function" ? globalThis.__container_report_error : null;
  let reporterBound = false;
  globalThis.__container_bind_timer_error_reporter = function(reporter) {
    if (reporterBound || typeof reporter !== "function") throw new TypeError("invalid timer error reporter");
    reportError = reporter;
    reporterBound = true;
  };
  function report(error) {
    if (!reportError) throw error;
    reportError(error);
  }
  const timers = new Map();
  // Bootstrap-only handoff into the lexical scheduler. Captured iteration and
  // the host wall clock prevent guest prototype changes from declaring idle.
  const schedulerApply = Reflect.apply;
  const schedulerValues = Map.prototype.values;
  const schedulerNext = Object.getPrototypeOf(timers.values()).next;
  const schedulerNow = Date.now;
  const schedulerFinite = Number.isFinite;
  globalThis.__container_scheduler_timer_ready = function() {
    const current = schedulerApply(schedulerNow, undefined, []);
    if (typeof current !== "number" || !schedulerFinite(current)) return true;
    const iterator = schedulerApply(schedulerValues, timers, []);
    for (let index = 0; index < maximumTasks; index += 1) {
      const item = schedulerApply(schedulerNext, iterator, []);
      if (item.done) return false;
      if (item.value.due <= current) return true;
    }
    return true;
  };

  const maximumDelay = 2147483647;
  const maximumTasks = 1000;
  let nextId = 0;
  let turn = null;

  function clock(value) {
    const current = value === undefined ? Date.now() : Number(value);
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new RangeError("timer clock must be a non-negative safe integer in Unix milliseconds");
    }
    return current;
  }

  function addDelay(current, delay) {
    return Math.min(Number.MAX_SAFE_INTEGER, current + delay);
  }

  function schedule(callback, delay, repeat, args) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    if (nextId === Number.MAX_SAFE_INTEGER) throw new RangeError("timer identifiers exhausted");
    const requested = Number(delay);
    const duration = Number.isNaN(requested) ? 0 : Math.trunc(Math.min(maximumDelay, Math.max(0, requested)));
    // Timers created by this turn's callbacks or microtasks use at least its
    // logical clock, even when the host delivers an overdue poll.
    const current = turn ? Math.max(clock(), turn.now) : clock();
    const id = ++nextId;
    timers.set(id, { id: id, callback: callback, args: args || [],
      due: addDelay(current, duration), delay: duration, repeat: !!repeat });
    return id;
  }

  function cancel(id) {
    return timers.delete(Number(id));
  }

  function begin(now, budget) {
    if (turn) throw new Error("timer turn is already active");
    const current = clock(now);
    const limit = budget === undefined ? maximumTasks : Number(budget);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumTasks) {
      throw new RangeError("timer task budget must be an integer from 1 to 1000");
    }
    // Freeze eligible identities, not a mutable-array cursor. A callback can
    // cancel itself, its neighbour or every timer without skipping a task.
    const candidates = Array.from(timers.values()).filter(function(timer) { return timer.due <= current; });
    candidates.sort(function(left, right) { return left.due - right.due || left.id - right.id; });
    turn = { now: current, limit: limit, candidates: candidates, cursor: 0, count: 0, fired: [] };
    return null;
  }

  function eligible(timer) {
    return timers.get(timer.id) === timer && timer.due <= turn.now;
  }

  function task() {
    if (!turn) throw new Error("timer turn is not active");
    while (turn.cursor < turn.candidates.length) {
      const timer = turn.candidates[turn.cursor];
      // A preceding task's microtask checkpoint may have cancelled this ID.
      if (!eligible(timer)) { turn.cursor += 1; continue; }
      if (turn.count === turn.limit) return false;
      turn.cursor += 1;
      turn.count += 1;
      // Requeue before invoking the callback so cancellation in the callback
      // or its checkpoint wins. An interval fires at most once in this turn;
      // missed periods coalesce and its next deadline uses this poll's clock.
      if (timer.repeat) timer.due = addDelay(turn.now, timer.delay);
      else timers.delete(timer.id);
      turn.fired.push(timer.id);
      try { timer.callback.apply(globalThis, timer.args); }
      catch (error) { report(error); }
      return true;
    }
    return false;
  }

  function end() {
    if (!turn) throw new Error("timer turn is not active");
    let pending = 0;
    for (let index = turn.cursor; index < turn.candidates.length; index += 1) {
      if (eligible(turn.candidates[index])) pending += 1;
    }
    const completed = turn;
    turn = null;
    if (pending && completed.count === completed.limit) {
      // Yield is normal flow control: report it without losing already-fired
      // IDs or converting a finite backlog into an engine failure.
      __container_events.push({ type: "timer.yield", reason: "task-budget", limit: completed.limit, pending: pending });
    }
    return completed.fired;
  }

  globalThis.__container_schedule = schedule;
  globalThis.__container_cancel_timer = cancel;
  globalThis.__container_timer_begin = begin;
  globalThis.__container_timer_task = task;
  globalThis.__container_timer_end = end;
  globalThis.__container_drain_timers = function() {
    throw new Error("timer draining requires the native task driver");
  };
  globalThis.setTimeout = function(callback, delay) {
    return schedule(callback, delay, false, Array.prototype.slice.call(arguments, 2));
  };
  globalThis.setInterval = function(callback, delay) {
    return schedule(callback, delay, true, Array.prototype.slice.call(arguments, 2));
  };
  globalThis.clearTimeout = cancel;
  globalThis.clearInterval = cancel;
  globalThis.queueMicrotask = function(callback) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    Promise.resolve().then(function() {
      try { callback(); } catch (error) { report(error); }
    });
  };
})();
