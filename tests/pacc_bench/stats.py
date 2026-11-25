"""
stats.py — Rigorous Statistical Analysis Tools for PACC Benchmarks
"""

import math
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
from scipy import stats  # type: ignore


def wilson_score_interval(
    successes: int,
    trials: int,
    confidence: float = 0.95,
) -> Tuple[float, float]:
    """
    Computes the Wilson score continuity-uncorrected interval for a binomial proportion.
    """
    if trials <= 0:
        return (0.0, 0.0)

    z = stats.norm.ppf(1.0 - (1.0 - confidence) / 2.0)
    p = successes / trials
    n = trials

    denominator = 1.0 + (z ** 2) / n
    centre_adjusted = p + (z ** 2) / (2.0 * n)
    spread = z * math.sqrt((p * (1.0 - p) / n) + (z ** 2) / (4.0 * (n ** 2)))

    ci_lower = max(0.0, (centre_adjusted - spread) / denominator)
    ci_upper = min(1.0, (centre_adjusted + spread) / denominator)

    return (ci_lower, ci_upper)


def summarize_rate(
    successes: int,
    trials: int,
    confidence: float = 0.95,
) -> Dict[str, Union[int, float]]:
    """
    Summarizes success count into rate percentage and Wilson 95% confidence interval.
    """
    if trials == 0:
        return {
            'trials': 0,
            'successes': 0,
            'rate_pct': 0.0,
            'ci_lower_pct': 0.0,
            'ci_upper_pct': 0.0,
            'margin_minus_pct': 0.0,
            'margin_plus_pct': 0.0,
        }

    rate = (successes / trials) * 100.0
    ci_low, ci_high = wilson_score_interval(successes, trials, confidence)
    ci_low_pct = ci_low * 100.0
    ci_high_pct = ci_high * 100.0

    return {
        'trials': trials,
        'successes': successes,
        'rate_pct': round(rate, 2),
        'ci_lower_pct': round(ci_low_pct, 2),
        'ci_upper_pct': round(ci_high_pct, 2),
        'margin_minus_pct': round(rate - ci_low_pct, 2),
        'margin_plus_pct': round(ci_high_pct - rate, 2),
    }


def mcnemar_test(
    pacc_passes: List[bool],
    qr_passes: List[bool],
) -> Dict[str, Any]:
    """
    Executes McNemar's test for paired binary trials (PACC vs. QR).
    Uses exact binomial test when b + c < 25, otherwise chi-squared with continuity correction.
    """
    n = min(len(pacc_passes), len(qr_passes))
    if n == 0:
        return {
            'n': 0,
            'p_value': 1.0,
            'statistic': 0.0,
            'significant': False,
        }

    both_pass = 0
    pacc_only = 0
    qr_only = 0
    both_fail = 0

    for np_res, qr_res in zip(pacc_passes, qr_passes):
        if np_res and qr_res:
            both_pass += 1
        elif np_res and not qr_res:
            pacc_only += 1
        elif not np_res and qr_res:
            qr_only += 1
        else:
            both_fail += 1

    b = pacc_only
    c = qr_only
    total_discordant = b + c

    if total_discordant == 0:
        p_val = 1.0
        stat = 0.0
    elif total_discordant < 25:
        p_val = stats.binomtest(b, total_discordant, 0.5).pvalue
        stat = float((abs(b - c) - 1) ** 2) / float(total_discordant) if total_discordant > 0 else 0.0
    else:
        stat = ((abs(b - c) - 1.0) ** 2) / float(total_discordant)
        p_val = stats.chi2.sf(stat, df=1)

    return {
        'n': n,
        'both_pass': both_pass,
        'pacc_only': pacc_only,
        'qr_only': qr_only,
        'both_fail': both_fail,
        'statistic': round(stat, 4),
        'p_value': float(p_val),
        'significant': p_val < 0.05,
    }


def summarize_distributions(values: List[float]) -> Dict[str, Any]:
    """
    Computes non-parametric summary statistics: median, IQR, percentiles, min, max, mean, std.
    """
    if not values:
        return {
            'n': 0,
            'median': 0.0,
            'iqr': 0.0,
            'q25': 0.0,
            'q75': 0.0,
            'p95': 0.0,
            'min': 0.0,
            'max': 0.0,
            'mean': 0.0,
            'std': 0.0,
        }

    arr = np.asarray(values, dtype=np.float64)
    q25 = float(np.percentile(arr, 25))
    q75 = float(np.percentile(arr, 75))
    median = float(np.median(arr))
    iqr = q75 - q25
    p95 = float(np.percentile(arr, 95))
    mean = float(np.mean(arr))
    std = float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0

    return {
        'n': len(arr),
        'median': round(median, 3),
        'iqr': round(iqr, 3),
        'q25': round(q25, 3),
        'q75': round(q75, 3),
        'p95': round(p95, 3),
        'min': round(float(np.min(arr)), 3),
        'max': round(float(np.max(arr)), 3),
        'mean': round(mean, 3),
        'std': round(std, 3),
    }


def detect_non_monotonic_anomalies(
    rates: List[float],
    rebound_threshold: float = 5.0,
) -> List[Tuple[int, float, float]]:
    """
    Detects empirical rebounds in degradation sweeps.
    Returns list of (index, drop_val, rebound_val).
    """
    anomalies = []
    if len(rates) < 3:
        return anomalies
    min_so_far = rates[0]
    for i in range(1, len(rates)):
        if rates[i] > min_so_far + rebound_threshold:
            anomalies.append((i, min_so_far, rates[i]))
        min_so_far = min(min_so_far, rates[i])
    return anomalies


def enforce_monotonic_downward(rates: List[float]) -> List[float]:
    """
    Forces a sequence to be monotonically decreasing by carrying the previous minimum forward.
    """
    if not rates:
        return []
    res = [rates[0]]
    for r in rates[1:]:
        res.append(min(r, res[-1]))
    return res


def find_threshold_crossover(
    levels: List[float],
    rates: List[float],
    target_rate: float = 50.0,
) -> Optional[float]:
    """
    Finds the interpolated level where the success rate drops across the target rate.
    Uses piecewise linear interpolation between adjacent levels without artificial smoothing.
    """
    if len(levels) < 2 or len(rates) < 2:
        return None

    r_eval = rates

    for i in range(len(r_eval) - 1):
        r1, r2 = r_eval[i], r_eval[i + 1]
        x1, x2 = levels[i], levels[i + 1]

        if (r1 >= target_rate >= r2) or (r1 <= target_rate <= r2):
            if abs(r2 - r1) < 1e-9:
                return round((x1 + x2) / 2.0, 3)
            fraction = (target_rate - r1) / (r2 - r1)
            return round(x1 + fraction * (x2 - x1), 3)

    if all(r >= target_rate for r in r_eval):
        return None
    if all(r <= target_rate for r in r_eval):
        return levels[0]

    return None

