"""Speaker-safe PCM playback: never send the agent's own audio back as speech."""
import queue
import threading
import time


def speaker_audio_class(base_class):
    """Wrap the pinned SDK audio interface; headphones retain full duplex.

    This is microphone gating, not acoustic echo cancellation. While output is
    queued/playing, send same-length silence to preserve the ASR audio clock.
    Resume after output-device latency, room echo and the input buffer have drained.
    """
    class SpeakerAudio(base_class):
        def __init__(self, mode="speakers", clock=time.monotonic, on_error=None):
            if mode not in {"speakers", "headphones"}:
                raise ValueError("SHOPSWARM_AUDIO_MODE must be speakers or headphones")
            super().__init__()
            self.mode = mode
            self._clock = clock
            self._on_error = on_error or (lambda: None)
            self._gate_lock = threading.RLock()
            self._pending = 0
            self._playing = False
            self._generation = 0
            self._mute_until = 0.0
            self._suppressed_bytes = 0
            self._forwarded_bytes = 0
            self._played_bytes = 0

        def output(self, audio):
            if not audio or self.should_stop.is_set(): return
            with self._gate_lock:
                self._pending += 1
                self.output_queue.put((self._generation, audio))

        def interrupt(self):
            with self._gate_lock:
                self._generation += 1
                try:
                    while True:
                        self.output_queue.get_nowait()
                        self._pending -= 1
                except queue.Empty:
                    pass
                # An in-flight write can still be audible; its finally block
                # extends the gate when it actually finishes.

        def _output_latency(self):
            try: return max(0.0, self.out_stream.get_output_latency())
            except (AttributeError, OSError): return 0.1

        def _play_one(self, generation, audio):
            with self._gate_lock:
                self._pending -= 1
                if generation != self._generation or self.should_stop.is_set(): return
                self._playing = True
            wrote = False
            try:
                # Bound the audio left after Stop/interrupt to one 62.5 ms block.
                block_bytes = self.OUTPUT_FRAMES_PER_BUFFER * 2
                for offset in range(0, len(audio), block_bytes):
                    with self._gate_lock:
                        if generation != self._generation or self.should_stop.is_set(): break
                    chunk = audio[offset:offset + block_bytes]
                    self.out_stream.write(chunk)
                    wrote = True
                    with self._gate_lock: self._played_bytes += len(chunk)
            finally:
                with self._gate_lock:
                    self._playing = False
                    if wrote:
                        self._mute_until = max(self._mute_until, self._clock()
                            + self._output_latency() + 0.35
                            + self.INPUT_FRAMES_PER_BUFFER / 16000)

        def _output_thread(self):
            while not self.should_stop.is_set():
                try:
                    generation, audio = self.output_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                try:
                    self._play_one(generation, audio)
                except Exception:
                    self.should_stop.set()
                    self._on_error()
                    return

        def _in_callback(self, in_data, frame_count, time_info, status):
            with self._gate_lock:
                muted = self.should_stop.is_set() or (self.mode == "speakers" and (
                    self._pending > 0 or self._playing or self._clock() < self._mute_until))
                if muted:
                    self._suppressed_bytes += len(in_data)
                    data = bytes(len(in_data))
                else:
                    self._forwarded_bytes += len(in_data)
                    data = in_data
                if self.input_callback: self.input_callback(data)
            return (None, self.pyaudio.paContinue)

        def diagnostics(self):
            with self._gate_lock:
                return {"audio_mode": self.mode, "played_bytes": self._played_bytes,
                        "suppressed_mic_bytes": self._suppressed_bytes,
                        "forwarded_mic_bytes": self._forwarded_bytes}

    return SpeakerAudio
