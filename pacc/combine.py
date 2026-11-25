"""
pacc.combine — Multi-frame soft-information combining for live video.

A camera sees the same symbol in many consecutive frames. Sensor noise, motion
blur, glare and specular highlights differ from frame to frame, so the channel
LLRs of frames that fail individually can be added (they are log-likelihoods of
independent observations of the same codeword bits) and decoded together.

LLRs are stored in codeword order, after the decoder has undone rotation and
mirroring, so frames taken at any orientation or distance combine directly as
long as they show the same symbol (same N, MCS and level).

    comb = FrameCombiner()
    for frame in camera:
        res = pacc.decode(frame, thorough=False, combiner=comb)
        if res.ok: break
"""
from __future__ import annotations

from collections import OrderedDict, deque
from dataclasses import dataclass, field

import numpy as np

Key = tuple[int, int, int]          # (N, MCS, level)


def llr_quality(llrs: np.ndarray) -> float:
    """Mean per-bit mutual information estimate, 1 - E[log2(1 + exp(-|L|))], in [0, 1]."""
    a = np.minimum(np.abs(llrs), 30.0)
    return float(1.0 - np.mean(np.log2(1.0 + np.exp(-a))))


CONSISTENCY_LLR = 2.0
CONSISTENCY_MIN_BITS = 32
CONSISTENCY_AGREE = 0.7


def consistent(a: np.ndarray, b: np.ndarray) -> bool:
    """Do two LLR vectors plausibly observe the same codeword?"""
    m = (np.abs(a) > CONSISTENCY_LLR) & (np.abs(b) > CONSISTENCY_LLR)
    if m.sum() < CONSISTENCY_MIN_BITS:
        return True
    return float(np.mean(np.sign(a[m]) == np.sign(b[m]))) >= CONSISTENCY_AGREE


@dataclass
class FrameCombiner:
    max_frames: int = 8
    max_keys: int = 3                # a misread format word must not wipe the real history
    min_quality: float = 0.05        # ignore frames that carry (almost) no information
    _hist: OrderedDict = field(default_factory=OrderedDict)
    _pending: tuple[float, Key, np.ndarray] | None = None

    # Called by the decoder ------------------------------------------------------
    def prior(self, key: Key, llrs: np.ndarray | None = None) -> np.ndarray | None:
        """Summed LLRs of earlier frames of this symbol, or None.

        With the current frame's llrs, the history is first checked for consistency:
        an animated stream (pacc.stream) shows different codewords under the same
        format word, and summing those would destroy both. Unrelated scrambled
        codewords agree on only ~50% of confident bit signs.
        """
        frames = self._hist.get(key)
        if not frames:
            return None
        total = np.sum(frames, axis=0)
        if llrs is not None and len(llrs) == len(total) and not consistent(total, llrs):
            del self._hist[key]
            return None
        return total

    def offer(self, key: Key, llrs: np.ndarray) -> None:
        """Candidate observation from the current frame; the best one is kept."""
        q = llr_quality(llrs)
        if q < self.min_quality:
            return
        if self._pending is None or q > self._pending[0]:
            self._pending = (q, key, llrs)

    # Called once per frame by pacc.decode ---------------------------------------
    def end_frame(self, success: bool) -> None:
        pending, self._pending = self._pending, None
        if success:
            self.reset()
            return
        if pending is None:
            return
        _, key, llrs = pending
        frames = self._hist.pop(key, None) or deque()
        # The same camera buffer read twice is not a new observation.
        if not (frames and len(frames[-1]) == len(llrs) and np.allclose(frames[-1], llrs, atol=1e-6)):
            frames.append(llrs)
        while len(frames) > self.max_frames:
            frames.popleft()
        self._hist[key] = frames
        while len(self._hist) > self.max_keys:
            self._hist.popitem(last=False)

    def frames_for(self, key: Key) -> int:
        return len(self._hist.get(key, ()))

    def reset(self) -> None:
        self._hist.clear()
        self._pending = None

    @property
    def frames(self) -> int:
        """Frames held for the most recently updated symbol."""
        return len(next(reversed(self._hist.values()))) if self._hist else 0

