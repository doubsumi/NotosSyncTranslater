"""Translation engine: a resilient pool of free upstream providers.

Design
------
* **Failover** — providers are tried in preference order until one succeeds.
* **Circuit breaker** — a provider that fails ``threshold`` times in a row is
  put on a cooldown and skipped, so one broken upstream cannot stall the app.
* **Latency EMA** — successful providers are ordered by recent latency; the
  pool round-robins within the healthy set so load is spread and no single
  free upstream is hammered.
* **Pacing** — at most one new call per provider per ``pacing`` seconds
  (per-provider lock), a cheap way to stay friends with free endpoints.
* **Bounded concurrency** — provider calls run on a shared thread pool with
  ``max_workers`` slots; a global semaphore prevents request bursts from
  creating thread storms.

All state is guarded by locks because Flask serves requests from multiple
threads.
"""
from __future__ import annotations

import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import translators as _ts  # the only third-party upstream client we use


class EngineError(Exception):
    """Raised when no provider could translate a chunk."""

    def __init__(self, message: str, provider_errors: dict[str, str] | None = None):
        super().__init__(message)
        self.message = message
        self.provider_errors = provider_errors or {}


@dataclass(slots=True)
class ProviderState:
    name: str
    #: Exponential-moving-average latency (seconds).
    latency: float = 2.0
    consecutive_failures: int = 0
    cooldown_until: float = 0.0
    last_call_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def healthy(self) -> bool:
        return time.monotonic() >= self.cooldown_until

    def record_success(self, elapsed: float) -> None:
        # EMA with alpha ~ 0.3.
        self.latency = 0.7 * self.latency + 0.3 * elapsed
        self.consecutive_failures = 0

    def record_failure(self, threshold: int, cooldown: float) -> None:
        self.consecutive_failures += 1
        if self.consecutive_failures >= threshold:
            self.cooldown_until = time.monotonic() + cooldown
            self.consecutive_failures = 0


class Engine:
    """Thread-safe translation engine."""

    def __init__(
        self,
        providers: tuple[str, ...],
        timeout: float = 12.0,
        pacing: float = 0.4,
        max_workers: int = 3,
        failure_threshold: int = 2,
        cooldown: float = 60.0,
    ) -> None:
        if not providers:
            raise ValueError("at least one provider is required")
        self.timeout = timeout
        self.pacing = pacing
        self.failure_threshold = failure_threshold
        self.cooldown = cooldown
        self._states = [ProviderState(name=p) for p in providers]
        self._rr_index = random.randrange(len(self._states))
        self._pool = ThreadPoolExecutor(
            max_workers=max(1, max_workers),
            thread_name_prefix="nst-provider",
        )
        self._semaphore = threading.Semaphore(max(1, max_workers))

    # ------------------------------------------------------------------
    def _call_provider(
        self, state: ProviderState, text: str, from_lang: str, to_lang: str
    ) -> str:
        """One paced, timed call to one provider (run inside the pool)."""
        with state.lock:
            wait = self.pacing - (time.monotonic() - state.last_call_at)
            if wait > 0:
                time.sleep(wait)
            state.last_call_at = time.monotonic()

        started = time.monotonic()
        try:
            result = _ts.translate_text(
                text,
                translator=state.name,
                from_language=from_lang,
                to_language=to_lang,
                timeout=self.timeout,
                if_use_preacceleration=False,
            )
            elapsed = time.monotonic() - started
            if not isinstance(result, str) or not result:
                raise ValueError("empty result")
            state.record_success(elapsed)
            return result
        except Exception as exc:  # noqa: BLE001 - upstreams fail in many ways
            state.record_failure(self.failure_threshold, self.cooldown)
            raise EngineError(
                f"provider {state.name} failed: {type(exc).__name__}: {str(exc)[:200]}"
            ) from exc

    def translate_one(
        self, text: str, from_lang: str, to_lang: str
    ) -> tuple[str, str]:
        """Translate ``text`` trying healthy providers in order.

        Returns ``(translation, provider_name)``. Raises :class:`EngineError`
        when every provider failed.
        """
        # Round-robin start among healthy providers to spread load.
        states = self._healthy_sorted()
        if not states:
            raise EngineError("all translation providers are cooling down; retry soon")
        provider_errors: dict[str, str] = {}
        for offset, state in enumerate(states):
            with self._semaphore:
                try:
                    result = self._pool.submit(
                        self._call_provider,
                        state,
                        text,
                        from_lang,
                        to_lang,
                    ).result(timeout=self.timeout + 10)
                    return result, state.name
                except EngineError as exc:
                    provider_errors[state.name] = str(exc)
        raise EngineError("no translation provider succeeded", provider_errors)

    # ------------------------------------------------------------------
    def _healthy_sorted(self) -> list[ProviderState]:
        healthy = [s for s in self._states if s.healthy]
        if not healthy:
            # Everything cooling down: allow the fastest to retry soon.
            return sorted(self._states, key=lambda s: s.cooldown_until)[:1]
        # Prefer low latency, then rotate the index so load spreads.
        healthy.sort(key=lambda s: s.latency)
        start = self._rr_index % len(healthy)
        ordered = healthy[start:] + healthy[:start]
        self._rr_index = (self._rr_index + 1) % len(healthy)
        return ordered

    @property
    def provider_status(self) -> list[dict]:
        return [
            {
                "name": s.name,
                "healthy": s.healthy,
                "latencyMs": round(s.latency * 1000),
                "consecutiveFailures": s.consecutive_failures,
            }
            for s in self._states
        ]

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
