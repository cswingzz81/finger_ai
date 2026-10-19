"""회의 녹취 대본(.txt)을 화자마다 목소리가 다른 회의 녹음 파일로 만든다. API 키 없이 오프라인으로 돈다.

PRD 12장 가짜 회의 대본(sample_meeting.txt)으로 '녹음 파일 업로드' 흐름을 시험할 때 쓴다.
음성은 Supertonic-3 한국어 TTS(sherpa-onnx)로 만들고, 처음 실행 때 모델(약 130MB)을 GitHub에서 받는다.
mp3 · m4a · wav 인코딩에는 ffmpeg가 필요하다.

사용법:
    pip install sherpa-onnx numpy
    python samples/make_sample_audio.py                        # samples/sample_meeting.mp3 생성
    python samples/make_sample_audio.py 대본.txt -o 회의.mp3     # 다른 대본으로 생성
"""

import argparse
import random
import subprocess
import tarfile
import urllib.request
from pathlib import Path

import numpy as np
import sherpa_onnx

HERE = Path(__file__).resolve().parent
MODEL_NAME = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
MODEL_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{MODEL_NAME}.tar.bz2"
MODEL_ROOT = Path.home() / ".cache" / "finger_ai"

# Supertonic-3 화자 번호: 0~4 여성, 5~9 남성
VOICES = {"김가람": 7, "이도윤": 5, "박서연": 3}
EXTRA_VOICES = [8, 1, 6, 2, 9, 0]  # 대본에 다른 이름이 나오면 차례로 배정

GAP_SAME = (0.35, 0.6)  # 같은 사람이 이어 말할 때 쉬는 시간(초)
GAP_TURN = (0.6, 1.0)  # 다른 사람으로 넘어갈 때


def parse_script(path):
    """'이름: 내용' 줄을 (이름, 내용) 목록으로 읽는다. 이름이 없는 줄은 '화자'로 본다."""
    lines = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        name, sep, text = line.partition(":")
        if sep and 0 < len(name.strip()) <= 20 and text.strip():
            lines.append((name.strip(), text.strip()))
        else:
            lines.append(("화자", line))
    return lines


def ensure_model(root=MODEL_ROOT):
    model_dir = root / MODEL_NAME
    if (model_dir / "voice.bin").exists():
        return model_dir
    root.mkdir(parents=True, exist_ok=True)
    archive = root / f"{MODEL_NAME}.tar.bz2"
    print(f"모델 내려받는 중 (약 130MB): {MODEL_URL}")
    urllib.request.urlretrieve(MODEL_URL, archive)
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter="data")
    archive.unlink()
    return model_dir


def load_tts(model_dir):
    def f(name):
        return str(model_dir / name)

    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            supertonic=sherpa_onnx.OfflineTtsSupertonicModelConfig(
                duration_predictor=f("duration_predictor.int8.onnx"),
                text_encoder=f("text_encoder.int8.onnx"),
                vector_estimator=f("vector_estimator.int8.onnx"),
                vocoder=f("vocoder.int8.onnx"),
                tts_json=f("tts.json"),
                unicode_indexer=f("unicode_indexer.bin"),
                voice_style=f("voice.bin"),
            ),
            num_threads=4,
        ),
    )
    return sherpa_onnx.OfflineTts(config)


def speak(tts, text, sid, speed):
    gen = sherpa_onnx.GenerationConfig()
    gen.sid = sid
    gen.num_steps = 8
    gen.speed = speed
    gen.extra["lang"] = "ko"
    audio = tts.generate(text, gen)
    samples = np.asarray(audio.samples, dtype=np.float32)
    if not samples.size:
        raise RuntimeError(f"음성을 만들지 못했습니다: {text}")
    return samples / max(np.abs(samples).max(), 1e-6) * 0.85, audio.sample_rate  # 사람마다 음량을 맞춘다


def build_meeting(script, out_path, speed=1.0, seed=7):
    lines = parse_script(script)
    voices = dict(VOICES)
    for name, _ in lines:
        if name not in voices:
            voices[name] = EXTRA_VOICES[(len(voices) - len(VOICES)) % len(EXTRA_VOICES)]

    tts = load_tts(ensure_model())
    rng = random.Random(seed)
    sr = tts.sample_rate
    pieces = [np.zeros(int(0.8 * sr), np.float32)]
    t = 0.8
    prev = None
    for i, (name, text) in enumerate(lines, 1):
        if prev is not None:
            gap = rng.uniform(*(GAP_SAME if name == prev else GAP_TURN))
            pieces.append(np.zeros(int(gap * sr), np.float32))
            t += gap
        samples, _ = speak(tts, text, voices[name], speed)
        print(f"[U{i} {int(t // 60):02d}:{t % 60:04.1f} {name}] {text}")
        pieces.append(samples)
        t += len(samples) / sr
        prev = name
    pieces.append(np.zeros(int(1.0 * sr), np.float32))
    mix = np.concatenate(pieces)

    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "-",
         "-ar", "44100", "-b:a", "64k", str(out_path)],
        input=mix.tobytes(),
        check=True,
    )
    return len(mix) / sr


def main():
    parser = argparse.ArgumentParser(description="회의 대본 → 여러 목소리 회의 녹음 파일")
    parser.add_argument("script", nargs="?", default=HERE / "sample_meeting.txt", help="'이름: 내용' 형식 대본")
    parser.add_argument("-o", "--out", default=HERE / "sample_meeting.mp3", help="출력 파일 (.mp3 · .m4a · .wav)")
    parser.add_argument("--speed", type=float, default=1.0, help="말 빠르기 (클수록 빠름)")
    args = parser.parse_args()

    sec = build_meeting(args.script, args.out, speed=args.speed)
    print(f"{args.out} · {int(sec // 60)}분 {sec % 60:.0f}초")


if __name__ == "__main__":
    main()
