#!/usr/bin/env python3
"""private/cards.json (평문) → data/recipes-enc.json (AES-GCM 256)

사용:  python3 tools/encrypt.py [PIN]
PIN 기본값 0301. 평문 파일은 .gitignore 로 저장소에서 빠집니다.
"""
import base64, json, os, sys
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIN = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("NOTE_PIN", "0301")
ITER = 250000

with open(os.path.join(ROOT, "private/cards.json"), encoding="utf-8") as f:
    src = json.load(f)

salt = os.urandom(16)
iv = os.urandom(12)
key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(PIN.encode())
ct = AESGCM(key).encrypt(iv, json.dumps(src, ensure_ascii=False).encode(), None)

b64 = lambda b: base64.b64encode(b).decode()
out = {
    "v": 1,
    "alg": "AES-GCM-256",
    "kdf": "PBKDF2-SHA256",
    "iter": ITER,
    "salt": b64(salt),
    "iv": b64(iv),
    "ct": b64(ct),
    "bytes": len(ct),
}
os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
with open(os.path.join(ROOT, "data/recipes-enc.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"encrypted {len(src['cards'])} card(s) -> data/recipes-enc.json ({len(ct)} bytes, {ITER} iterations)")
