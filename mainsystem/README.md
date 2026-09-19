# ShopSwarm

A voice-operated retail team that checks physical stock before promising an order.

An inventory discrepancy sends a robot specialist to inspect a bay. Finance checks the budget while inventory works. Marketing asks inventory to verify an affordable alternative. A human approves the exact order, then the robot verifies completion before the test ledger is reconciled.

**Status:** working starter harness and deterministic offline demo. Live Mel, ElevenLabs microphone audio, external sensors, and Quarky motion require onsite validation. No real payments are implemented. This preparation is not represented as completed work within a verified event build window.

Start with [START_HERE.md](START_HERE.md), then [CODEX_HANDOFF.md](CODEX_HANDOFF.md).

## Included

- Python 3.11+ asynchronous coordinator; separate scoped conversations for inventory, robot, finance and marketing.
- ElevenLabs customer voice agent configuration and six local client tools.
- Mel NDJSON relay adapter, explicitly selected chat-completions fallback, and labeled scripted fixture.
- Local operator console, human approval, command deduplication, stop latch, SQLite event trace, and current-session state.
- Sensor event ingestion, change-triggered inspection, Pico template, serial forwarder, and documented Quarky bridge contract.
- Meaningful failure-path tests, documentation review, arrival plan and provenance record.

## Quick start

```text
python -m shopswarm demo
python -m shopswarm serve
python -m unittest discover -s tests -v
```

Run from this folder. The core uses Python's standard library. Optional voice and serial dependencies have separate requirements files. The fixture automatically represents human approval only in the offline `demo` command; that command refuses live modes.

## Layout

| Path | Purpose |
| --- | --- |
| `shopswarm/core.py` | Tasks, delegation, orders, evidence checks and test ledger |
| `shopswarm/agents.py` | Independent conversations, tool scopes and budgets |
| `shopswarm/providers.py` | Mel, compatible chat API, and fixture providers |
| `shopswarm/voice.py` | ElevenLabs setup and local voice tool execution |
| `shopswarm/devices.py` | Simulator and hardware HTTP contract client |
| `shopswarm/server.py` | Loopback server and human operator API |
| `scripts/sensor_bridge.py` | Confirmed serial sensor to local event API |
| `docs/` | Architecture, source review, verification and onsite priorities |

## Practical limits

This is a coordinated specialist system with bounded workflows, not a general autonomous robot fleet. Persistent events support audit and replay analysis; pending orders and jobs are intentionally not recovered on restart. Live account permissions, latency, sensor calibration, motor stopping and arrival detection have not been tested. The finance and marketing paths are starter demonstrations, not complete financial or campaign products.

License: MIT. The source package contains no API keys, account state or third-party documentation copies.
