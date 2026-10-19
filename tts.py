"""Gemini 3.8 Flash-Lite TTS로 한국어 텍스트를 신뢰감 있는 남성 목소리 WAV로 변환한다.

사용법:
    export GEMINI_API_KEY=...
    python tts.py "안녕하세요, 오늘의 소식을 전해드리겠습니다." -o hello.wav
    python tts.py --all-voices "샘플 문장"   # 후보 목소리별 샘플 생성
"""

import argparse
import sys
import wave

from google import genai
from google.genai import types

MODEL = "gemini-3.8-flash-lite-tts"

# 신뢰감 있는 남성 프리빌트 음성 후보
DEFAULT_VOICE = "Charon"
MALE_TRUSTED_VOICES = {
    "Charon": "Informative - 차분한 정보 전달형, 뉴스 앵커 톤 (기본값)",
    "Sadaltager": "Knowledgeable - 박식하고 안정된 전문가 톤",
    "Rasalgethi": "Informative - 설명형, 강의 톤",
    "Schedar": "Even - 고르고 흔들림 없는 톤",
    "Orus": "Firm - 단단하고 단호한 톤",
    "Alnilam": "Firm - 힘 있고 묵직한 톤",
    "Iapetus": "Clear - 또렷한 발음",
}

# 낭독 스타일 지시문. TRANSCRIPT 아래 텍스트만 읽고 지시문은 읽지 않는다.
STYLE_PROMPT = """\
### DIRECTOR'S NOTES
Voice: A mature Korean man with a low, steady, resonant voice.
Tone: Trustworthy, calm and warm, like an experienced news anchor or a professional consultant.
Pace: Unhurried, moderate pace with natural pauses. Finish each sentence clearly.
Pronunciation: Standard Seoul Korean, clear articulation. No exaggeration.

### TRANSCRIPT
"""

# 응답 오디오 형식: 16-bit PCM, 24kHz, mono
SAMPLE_RATE = 24000
SAMPLE_WIDTH = 2
CHANNELS = 1


def synthesize(text, out_path, voice=DEFAULT_VOICE, client=None):
    """text를 음성으로 합성해 out_path에 WAV로 저장하고 경로를 반환한다."""
    client = client or genai.Client()  # GEMINI_API_KEY 환경변수 사용
    response = client.models.generate_content(
        model=MODEL,
        contents=STYLE_PROMPT + text,
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice),
                ),
            ),
        ),
    )
    if not response.candidates or not response.candidates[0].content:
        raise RuntimeError(f"오디오가 생성되지 않았습니다: {response}")
    pcm = response.candidates[0].content.parts[0].inline_data.data

    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return out_path


def main():
    parser = argparse.ArgumentParser(description="Gemini TTS 한국어 남성 음성 생성")
    parser.add_argument("text", nargs="?", help="읽을 텍스트 (생략하면 표준입력에서 읽음)")
    parser.add_argument("-o", "--out", default="out.wav", help="출력 WAV 경로")
    parser.add_argument("-v", "--voice", default=DEFAULT_VOICE, help=f"음성 이름 (기본: {DEFAULT_VOICE})")
    parser.add_argument("--all-voices", action="store_true", help="후보 목소리마다 sample_<이름>.wav 생성")
    parser.add_argument("--list-voices", action="store_true", help="후보 목소리 목록 출력")
    args = parser.parse_args()

    if args.list_voices:
        for name, desc in MALE_TRUSTED_VOICES.items():
            print(f"{name:12} {desc}")
        return

    text = args.text or sys.stdin.read().strip()
    if not text:
        parser.error("읽을 텍스트가 없습니다.")

    client = genai.Client()
    voices = MALE_TRUSTED_VOICES if args.all_voices else [args.voice]
    for voice in voices:
        out = f"sample_{voice}.wav" if args.all_voices else args.out
        print(synthesize(text, out, voice=voice, client=client))


if __name__ == "__main__":
    main()
