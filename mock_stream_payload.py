#!/usr/bin/env python3
"""Send a sample Git update or a bounded local webhook benchmark."""

import argparse
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
import hashlib
import ipaddress
import json
import os
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


DEFAULT_WEBHOOK_URL = "http://localhost:5678/webhook/context-update"
# Server-side phases reported in the pipeline response's `timings` object.
TIMING_PHASES = (
    ("preExecutionMs", "Pre-execution wait"),
    ("intakeMs", "Intake"),
    ("embeddingMs", "Embedding"),
    ("vectorStoreMs", "Vector store"),
    ("modelMs", "Model"),
    ("registryMs", "Registry"),
    ("workflowMs", "Workflow total"),
)
MAX_BENCHMARK_COUNT = 1000
MAX_BENCHMARK_CONCURRENCY = 20


def generate_context_payload(index=0, run_id=None, trajectory_id=None, sequence_num=None):
    """Build a Git document update matching the pipeline's webhook contract."""
    run_id = run_id or "demo"
    content = f"""---
title: Agent Memory Grid{f' Benchmark {index:04d}' if index else ''}
tags: [components]
---

# Agent Memory Grid

The orchestration grid uses `--ds-color-surface-default` for its canvas,
`--ds-space-400` for section gutters, and `--ds-radius-200` for cards.
Benchmark request: {run_id}-{index:04d}.
"""
    commit = hashlib.sha1(f"{run_id}-{index}".encode("utf-8")).hexdigest()
    return {
        "source": "git",
        "repository": "agentic-ai-platform",
        "ref": "refs/heads/main",
        "commit": commit,
        "author": "Context Pipeline Demo",
        "message": (
            f"Benchmark trajectory {trajectory_id}, sequence {sequence_num}"
            if trajectory_id is not None
            else "Update agent memory grid documentation"
        ),
        "documents": [
            {
                "path": (
                    f"docs/guides/agent-memory-grid-{index:04d}.md"
                    if index
                    else "docs/guides/agent-memory-grid.md"
                ),
                "status": "modified",
                "content": content,
            }
        ],
    }


def post_payload(webhook_url, token, payload, timeout=30, request_id=None):
    """Post one payload and return its HTTP result and elapsed time."""
    headers = {
        "Content-Type": "application/json",
        "x-context-token": token,
        # Lets the pipeline report time spent before the workflow started (e.g. queue wait).
        "x-sent-at": str(int(time.time() * 1000)),
    }
    if request_id:
        headers["x-request-id"] = request_id
    request = Request(
        webhook_url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return response.status, body, time.perf_counter() - started, None
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return error.code, body, time.perf_counter() - started, None
    except (URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        return None, "", time.perf_counter() - started, str(reason)


def stream_payload_to_pipeline(webhook_url, token):
    payload = generate_context_payload()
    print(f"Sending sample documentation update for commit {payload['commit'][:8]}...")
    status, body, _, error = post_payload(webhook_url, token, payload)
    if error:
        print(f"Could not reach the n8n webhook at {webhook_url}: {error}", file=sys.stderr)
        print("Check that the stack is running and the webhook URL is correct.", file=sys.stderr)
        return 1
    print(f"Pipeline returned HTTP {status}:")
    print(body)
    return 0 if status is not None and 200 <= status < 300 else 1


def is_loopback_webhook(url):
    """Restrict load generation to local hosts to avoid impacting third parties."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        hostname = parsed.hostname.lower()
        if hostname == "localhost" or hostname.endswith(".localhost"):
            return True
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def percentile(values, fraction):
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) * fraction + 0.999999)) - 1))
    return ordered[index]


def print_phase_breakdown(phase_samples):
    """Print server-side phase percentiles reported by the pipeline."""
    if not any(phase_samples.values()):
        print("  Server phases:      not reported by this pipeline version")
        return
    print("  Server phases (ms)       p50       p95       max     n")
    for key, label in TIMING_PHASES:
        values = phase_samples[key]
        if not values:
            continue
        print(
            f"    {label:<20}{percentile(values, 0.50):>8.0f}  {percentile(values, 0.95):>8.0f}  "
            f"{max(values):>8.0f}  {len(values):>4}"
        )
    print("  Pre-execution wait assumes the client and n8n share a clock (same host).")


def benchmark(
    webhook_url,
    token,
    count=100,
    concurrency=10,
    trajectories=5,
    timeout=30,
    confirmed=False,
):
    if not is_loopback_webhook(webhook_url):
        print("Benchmark mode only sends load to localhost or a loopback IP.", file=sys.stderr)
        return 2
    if not confirmed:
        try:
            answer = input(
                f"This will send {count} updates to {webhook_url} "
                f"(up to {concurrency} concurrent). Continue? Type 'yes': "
            )
        except EOFError:
            answer = ""
        if answer.strip().lower() != "yes":
            print("Benchmark cancelled.")
            return 2

    run_id = uuid.uuid4().hex
    print(
        f"Starting {count} webhook requests across {trajectories} simulated trajectories "
        f"(concurrency={concurrency}, timeout={timeout}s)."
    )
    print("Trajectory completion times are client-side aggregates, not n8n agent telemetry.")
    started = time.perf_counter()
    results = []
    phase_samples = {key: [] for key, _ in TIMING_PHASES}
    futures = {}
    expected_by_trajectory = {}
    submitted_by_trajectory = {}
    executor = ThreadPoolExecutor(max_workers=concurrency)
    interrupted = False

    def collect_result(future, metadata):
        index = metadata["index"]
        trajectory_id = metadata["trajectory_id"]
        if future.cancelled():
            results.append((index, None, 0, "cancelled", trajectory_id, None))
            return
        try:
            status, body, elapsed, error = future.result()
        except CancelledError:
            results.append((index, None, 0, "cancelled", trajectory_id, None))
            return
        ok = status is not None and 200 <= status < 300
        if ok:
            try:
                response_json = json.loads(body)
                ok = response_json.get("ok", True) is not False
                timings = response_json.get("timings") or {}
                for key, _ in TIMING_PHASES:
                    if isinstance(timings.get(key), (int, float)):
                        phase_samples[key].append(timings[key])
            except (json.JSONDecodeError, AttributeError):
                pass
        message = f"HTTP {status}" if status is not None else f"ERROR {error}"
        print(
            f"[{index:04d}/{count:04d}] [{trajectory_id}] {message} "
            f"in {elapsed * 1000:.1f} ms"
        )
        results.append(
            (
                index,
                status if ok else None,
                elapsed,
                None if ok else error or body,
                trajectory_id,
                time.perf_counter(),
            )
        )

    try:
        for index in range(1, count + 1):
            trajectory_number = (index - 1) % trajectories + 1
            sequence_num = (index - 1) // trajectories + 1
            trajectory_id = f"{run_id[:8]}-traj-{trajectory_number:03d}"
            expected_by_trajectory[trajectory_id] = (
                expected_by_trajectory.get(trajectory_id, 0) + 1
            )
            submitted_by_trajectory.setdefault(trajectory_id, time.perf_counter())
            payload = generate_context_payload(
                index, run_id, trajectory_id, sequence_num
            )
            request_id = (
                f"bench-{run_id[:8]}-t{trajectory_number:03d}-s{sequence_num:04d}"
            )
            future = executor.submit(
                post_payload, webhook_url, token, payload, timeout, request_id
            )
            futures[future] = {
                "index": index,
                "trajectory_id": trajectory_id,
                "sequence_num": sequence_num,
            }

        try:
            for future in as_completed(futures):
                collect_result(future, futures[future])
        except KeyboardInterrupt:
            interrupted = True
            print("\nInterrupt received; cancelling requests that have not started.", file=sys.stderr)
            for future in futures:
                future.cancel()
    finally:
        executor.shutdown(wait=True, cancel_futures=True)

    elapsed_total = time.perf_counter() - started
    recorded = {result[0] for result in results}
    for future, metadata in futures.items():
        index = metadata["index"]
        if index in recorded:
            continue
        collect_result(future, metadata)

    latencies = [result[2] for result in results if result[1] is not None]
    successes = len(latencies)
    failures = sum(1 for result in results if result[1] is None and result[3] != "cancelled")
    cancelled = sum(1 for result in results if result[3] == "cancelled")
    completed_requests = successes + failures
    completed_by_trajectory = {}
    for result in results:
        trajectory_id = result[4]
        if trajectory_id is None:
            continue
        trajectory_results = completed_by_trajectory.setdefault(
            trajectory_id, {"count": 0, "failures": 0, "last_completion": None}
        )
        trajectory_results["count"] += 1
        if result[1] is None:
            trajectory_results["failures"] += 1
        elif result[5] is not None:
            trajectory_results["last_completion"] = max(
                trajectory_results["last_completion"] or result[5], result[5]
            )
    trajectory_latencies = [
        trajectory_results["last_completion"] - submitted_by_trajectory[trajectory_id]
        for trajectory_id, trajectory_results in completed_by_trajectory.items()
        if trajectory_results["count"] == expected_by_trajectory[trajectory_id]
        and trajectory_results["failures"] == 0
        and trajectory_results["last_completion"] is not None
    ]

    print("\nBenchmark summary")
    print(f"  Requests completed: {completed_requests} / {count}")
    print(f"  Successful:         {successes}")
    print(f"  Failed:             {failures}")
    print(
        f"  Failure rate:       {failures / completed_requests * 100:.1f}%"
        if completed_requests
        else "  Failure rate:       n/a"
    )
    print(f"  Cancelled:          {cancelled}")
    print(f"  Elapsed:            {elapsed_total:.2f} s")
    print(
        f"  Throughput:         {completed_requests / elapsed_total:.2f} requests/s"
        if elapsed_total
        else "  Throughput:         n/a"
    )
    if latencies:
        print(f"  Latency p50:        {percentile(latencies, 0.50) * 1000:.1f} ms")
        print(f"  Latency p95:        {percentile(latencies, 0.95) * 1000:.1f} ms")
        print(f"  Latency max:        {max(latencies) * 1000:.1f} ms")
    print_phase_breakdown(phase_samples)
    print(
        f"  Trajectories done:  {len(trajectory_latencies)} / {trajectories}"
    )
    print(
        f"  Trajectory rate:    {len(trajectory_latencies) / elapsed_total:.2f} trajectories/s"
        if elapsed_total
        else "  Trajectory rate:    n/a"
    )
    if trajectory_latencies:
        print(
            f"  Trajectory p50:     {percentile(trajectory_latencies, 0.50) * 1000:.1f} ms"
        )
        print(
            f"  Trajectory p95:     {percentile(trajectory_latencies, 0.95) * 1000:.1f} ms"
        )
    if interrupted:
        print("  Note: in-flight HTTP requests were allowed to finish; queued futures were cancelled.")
    return 130 if interrupted else (0 if failures == 0 and cancelled == 0 else 1)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", action="store_true", help="send a bounded concurrent load test")
    parser.add_argument("--count", type=int, default=100, help="benchmark request count (1-1000)")
    parser.add_argument("--concurrency", type=int, default=10, help="maximum in-flight requests (1-20)")
    parser.add_argument("--trajectories", type=int, default=5, help="number of client-simulated trajectories (1-100)")
    parser.add_argument("--timeout", type=float, default=30, help="per-request timeout in seconds (1-120)")
    parser.add_argument("--yes", action="store_true", help="skip the interactive benchmark confirmation")
    args = parser.parse_args(argv)
    if not 1 <= args.count <= MAX_BENCHMARK_COUNT:
        parser.error(f"--count must be 1-{MAX_BENCHMARK_COUNT}")
    if not 1 <= args.concurrency <= MAX_BENCHMARK_CONCURRENCY:
        parser.error(f"--concurrency must be 1-{MAX_BENCHMARK_CONCURRENCY}")
    if not 1 <= args.trajectories <= min(args.count, 100):
        parser.error(f"--trajectories must be 1-{min(args.count, 100)}")
    if not 1 <= args.timeout <= 120:
        parser.error("--timeout must be 1-120 seconds")
    if not args.benchmark and args.yes:
        parser.error("--yes is only valid with --benchmark")
    return args


def main(argv=None):
    args = parse_args(argv)
    webhook_url = os.environ.get("N8N_WEBHOOK_URL", DEFAULT_WEBHOOK_URL)
    token = os.environ.get("CONTEXT_WEBHOOK_TOKEN")
    if not token:
        print("Set CONTEXT_WEBHOOK_TOKEN to the same value configured for n8n.", file=sys.stderr)
        return 2
    if args.benchmark:
        return benchmark(
            webhook_url,
            token,
            count=args.count,
            concurrency=args.concurrency,
            trajectories=args.trajectories,
            timeout=args.timeout,
            confirmed=args.yes,
        )
    return stream_payload_to_pipeline(webhook_url, token)


if __name__ == "__main__":
    raise SystemExit(main())
