"""BMU Hub forecasting models (v20).

Pure Python (standard library only) so the maths can be tested without any packages:
- revenue: Holt's linear exponential smoothing on past monthly revenue, blended with the
  sales forecast (live retainers + weighted pipeline) and a confidence band from past error;
- churn: the same rules as packages/shared/src/metrics (churnRisk), calibrated with a logistic curve.
"""
from __future__ import annotations

import math
from typing import Any


def holt(values: list[float], horizon: int, alpha: float = 0.5, beta: float = 0.3) -> list[float]:
    if not values:
        return [0.0] * horizon
    if len(values) == 1:
        return [float(values[0])] * horizon
    level, trend = float(values[0]), float(values[1] - values[0])
    for v in values[1:]:
        prev = level
        level = alpha * v + (1 - alpha) * (level + trend)
        trend = beta * (level - prev) + (1 - beta) * trend
    return [max(0.0, level + trend * (k + 1)) for k in range(horizon)]


def _best_alpha(values: list[float]) -> tuple[float, float]:
    """Picks smoothing parameters with the smallest one-step-ahead error on the history."""
    if len(values) < 4:
        return 0.5, 0.3
    best = (0.5, 0.3, float("inf"))
    for a in (0.2, 0.35, 0.5, 0.65, 0.8):
        for b in (0.1, 0.2, 0.3, 0.5):
            err = 0.0
            for i in range(2, len(values)):
                err += (holt(values[:i], 1, a, b)[0] - values[i]) ** 2
            if err < best[2]:
                best = (a, b, err)
    return best[0], best[1]


def revenue(body: dict[str, Any]) -> dict[str, Any]:
    history = [float(x) for x in body.get("history", [])]
    committed = [float(x) for x in body.get("committed", [])]
    pipeline = [float(x) for x in body.get("pipeline", [])]
    horizon = int(body.get("horizon") or len(committed) or 3)
    a, b = _best_alpha(history)
    trend = holt(history, horizon, a, b)
    # Typical one-step error on the history sets the band.
    errs = [abs(holt(history[:i], 1, a, b)[0] - history[i]) for i in range(2, len(history))]
    spread = (sum(errs) / len(errs)) if errs else (trend[0] * 0.2 if trend else 0.0)
    expected, low, high = [], [], []
    for i in range(horizon):
        c = committed[i] if i < len(committed) else 0.0
        p = pipeline[i] if i < len(pipeline) else 0.0
        e = 0.7 * p + 0.3 * trend[i] if p > 0 else trend[i]
        e = max(c, e)
        band = spread * math.sqrt(i + 1)
        expected.append(round(e))
        low.append(round(max(c, e - band)))
        high.append(round(e + band))
    return {"expected": expected, "low": low, "high": high, "method": f"Holt smoothing (alpha {a}, beta {b}) blended with the pipeline"}


def churn_one(s: dict[str, Any]) -> dict[str, Any]:
    reasons: list[dict[str, Any]] = []

    def add(impact: float, label: str) -> None:
        if impact > 0:
            reasons.append({"label": label, "impact": round(impact)})

    lost = max(0.0, 100 - float(s.get("healthScore", 100)))
    hr = s.get("healthReasons") or []
    if lost > 0 and hr:
        each = lost * 0.6 / len(hr)
        for r in hr:
            add(each, r)
    ends = s.get("endsInDays")
    if ends is not None and ends <= 45:
        add(25 if ends <= 15 else 15, f"Retainer ends in {max(0, int(ends))} days with no renewal yet")
    change = s.get("activityChangePct")
    if change is not None and change <= -30:
        add(20 if change <= -60 else 12, f"Client activity down {abs(round(change))}% on the month before")
    if float(s.get("tenureDays", 999)) < 90:
        add(8, "New client (first three months carry the most churn)")
    raw = sum(r["impact"] for r in reasons)
    # Logistic calibration: keeps the order of the rule score but spreads the middle.
    score = 100 / (1 + math.exp(-(raw - 45) / 12)) if raw > 0 else 0
    reasons.sort(key=lambda r: -r["impact"])
    return {"id": s.get("id"), "score": max(0, min(100, round(score))), "reasons": reasons}


def churn(body: dict[str, Any]) -> dict[str, Any]:
    return {"results": [churn_one(c) for c in body.get("clients", [])], "method": "rule score with logistic calibration"}
