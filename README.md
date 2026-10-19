# finger_ai

## 음성 합성 (TTS)

`tts.py`는 **Gemini 3.8 Flash-Lite TTS**(`gemini-3.8-flash-lite-tts`)로 한국어 텍스트를
신뢰감 있는 남성 목소리 WAV(24kHz, 16-bit, mono)로 만들어요.

### 설치

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=발급받은_키   # https://aistudio.google.com/apikey
```

### 사용

```bash
# 기본 목소리(Charon)로 생성
python tts.py "안녕하세요, 오늘의 소식을 전해드리겠습니다." -o hello.wav

# 다른 목소리로 생성
python tts.py "안녕하세요." -v Sadaltager -o hello.wav

# 후보 목소리 7개를 한 번에 생성해서 들어보고 고르기
python tts.py --all-voices "안녕하세요, 고객님. 문의하신 내용 안내해 드리겠습니다."

# 후보 목록 보기
python tts.py --list-voices
```

코드에서 쓰기:

```python
from tts import synthesize

synthesize("안녕하세요.", "hello.wav")
```

### 목소리와 톤 조정

- 목소리: `tts.py`의 `DEFAULT_VOICE`를 바꾸세요. 후보는 `MALE_TRUSTED_VOICES`에 있어요.
- 톤, 속도, 발음: `STYLE_PROMPT`의 `DIRECTOR'S NOTES`를 고치세요. 한국어로 써도 돼요.
  모델은 `### TRANSCRIPT` 아래 텍스트만 읽어요.
