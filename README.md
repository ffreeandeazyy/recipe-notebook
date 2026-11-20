# 레시피 노트 · Recipe Notebook

짝꿍의 손글씨 레시피를 모닝글로리 링 노트 카드 모양으로 옮긴 개인 레시피북입니다.

- 주소: https://ffreeandeazyy.github.io/recipe-notebook/
- 첫 화면에서 네 자리 비밀번호를 눌러야 카드가 열립니다.
- 레시피 본문은 `data/recipes-enc.json` 에 AES-GCM 으로 암호화되어 있어, 소스만 봐서는 내용이 보이지 않습니다.

## 쓰는 법

- 위쪽 검색창에서 제목·재료·메모를 바로 찾습니다. (예: 아몬드, 초코, 버터)
- 카테고리 탭으로 스프레드·소스 / 디저트 / 음료 / 베이킹 / 기타를 골라 봅니다.
- 카드 아래 `원본 손글씨 보기` 로 짝꿍의 손글씨 사진을 띄웁니다.
- `+ 새 카드` 로 새 레시피를 이 브라우저에 저장합니다. (사진 첨부 가능)
- 목차 시트에서 `JSON 내보내기` 로 저장한 카드를 파일로 백업합니다.
- 다 보면 `잠그기` 로 다시 잠급니다. (탭을 닫아도 잠김)

## 내장 카드 고치기

평문 원본은 `private/cards.json` 에 두고, 아래 명령으로 암호문을 다시 만듭니다.

```bash
python3 tools/encrypt.py        # PIN 은 NOTE_PIN 환경변수로 바꿀 수 있습니다
git add data/recipes-enc.json && git commit -m "카드 갱신" && git push
```
