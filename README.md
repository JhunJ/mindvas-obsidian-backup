# Mindvas Obsidian Backup

Obsidian **Mindvas** 플러그인 커스텀 버전과 관련 설정 백업 저장소입니다.

> upstream [Mindvas](https://github.com/mobench/mindvas) (v0.3.0) 기반 + 로컬 커스터마이징

## 포함 내용

| 경로 | 설명 |
|------|------|
| `plugin/` | 커스텀 `main.js`, `styles.css`, `manifest.json`, `data.json` |
| `obsidian-config/data.json` | Mindvas 플러그인 설정 |
| `obsidian-config/hotkeys-mindvas.json` | Mindvas 관련 단축키만 추출 |

## 커스텀 기능 요약

- 우측 **Map outline** 패널 (그룹 / Ungrouped / 검색 / 접기)
- **Heptabase 스타일 그룹** (이름, 색상, `Ctrl+G` 그룹화)
- file 노트 제목 아웃라인 표시
- 그래픽 뷰 토글 `Ctrl+Shift+G`

## 복원 방법

### 1. 플러그인 파일

```powershell
$vault = "C:\Users\AN-WKS\Documents\Obsidian Vault"
Copy-Item -Recurse -Force ".\plugin\*" "$vault\.obsidian\plugins\mindvas\"
```

### 2. 플러그인 설정

```powershell
Copy-Item -Force ".\obsidian-config\data.json" "$vault\.obsidian\plugins\mindvas\data.json"
```

### 3. 단축키 (선택)

`obsidian-config/hotkeys-mindvas.json` 내용을 Vault의 `.obsidian/hotkeys.json`에 **병합**하세요.  
기존 다른 플러그인 단축키는 덮어쓰지 않도록 주의하세요.

### 4. Obsidian에서

1. 설정 → Community plugins → Mindvas **끄기 → 켜기** (또는 Obsidian 재시작)
2. Canvas에서 mindmap 모드 / outline 패널 동작 확인

## 단축키 (이 저장소 기준)

| 단축키 | 기능 |
|--------|------|
| `Ctrl+G` | 선택 노트 그룹화 |
| `Ctrl+Shift+G` | 그래픽 뷰 토글 |
| `Ctrl+.` | 자식 노드 추가 |
| `Ctrl+Enter` | 형제 노드 추가 |
| `F2` | 노드 편집 |
| `Alt+방향키` | 노드 이동 |

## 업데이트 백업

Vault에서 수정 후 이 저장소에 다시 복사:

```powershell
$vault = "C:\Users\AN-WKS\Documents\Obsidian Vault"
$repo = "C:\Users\AN-WKS\Documents\mindvas-obsidian-backup"
Copy-Item -Force "$vault\.obsidian\plugins\mindvas\*" "$repo\plugin\"
Copy-Item -Force "$vault\.obsidian\plugins\mindvas\data.json" "$repo\obsidian-config\data.json"
cd $repo
git add -A
git commit -m "Sync mindvas customizations from vault"
git push
```
