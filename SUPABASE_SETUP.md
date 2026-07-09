# Supabase + GitHub Pages 설정

## 1. Supabase SQL 실행

Supabase 프로젝트에서 `SQL Editor`를 열고 `supabase-github-pages-schema.sql` 내용을 실행합니다.

생성되는 항목:

- `audit_reports`
- `audit_items`
- `audit-files` Storage bucket
- GitHub Pages에서 읽기/쓰기 가능한 RLS 정책

## 2. Supabase 키 확인

Supabase 프로젝트에서 아래 값을 확인합니다.

- `Project Settings > API > Project URL`
- `Project Settings > API > anon public key`

## 3. 사이트 설정 파일 수정

`supabase-config.js`를 열고 아래처럼 입력합니다.

```js
window.SUPABASE_CONFIG = {
  url: "https://YOUR_PROJECT_ID.supabase.co",
  anonKey: "YOUR_ANON_PUBLIC_KEY",
  bucket: "audit-files"
};
```

## 4. GitHub에 업로드

`dark-pattern-github-pages-upload` 폴더 안의 파일들을 GitHub repo 루트에 다시 업로드합니다.

반드시 포함:

- `audit.html`
- `audit.js`
- `audit.css`
- `supabase-config.js`
- `audit-data`

## 주의

현재 SQL은 공유 편의를 위해 anon 사용자에게 읽기/쓰기/삭제 권한을 열어둔 설정입니다.
회사 내부 운영으로 굳히려면 인증 또는 Edge Function 기반 저장 방식으로 권한을 좁히는 것이 안전합니다.
