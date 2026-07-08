# Nemotron Korea Persona Research

Nemotron-Personas-Korea 기반 합성 한국 페르소나 리서치 웹앱입니다.

## 실행

```bash
cd persona-research-site
npm run dev
```

브라우저에서 `http://localhost:5177`을 엽니다.

## AI API Key

AI 응답을 붙이고 싶으면 `.env.example`을 참고해 `.env`를 만들고 `GEMINI_API_KEY`를 넣습니다.

```bash
GEMINI_API_KEY=your_key_here
PORT=5177
```

키는 프론트엔드로 내려가지 않고, 서버 프로세스 메모리에서만 사용됩니다. 키가 없으면 규칙 기반 인터뷰 엔진으로 동작합니다.

## 검수 목록 저장소

로컬에서는 `audit-data/reports.json`과 `audit-data/uploads`를 사용합니다.
배포 환경에서 저장 히스토리를 유지하려면 Vercel Storage를 사용합니다.

1. Vercel 프로젝트의 Storage 탭에서 Blob store를 만듭니다.
2. 같은 Storage 또는 Marketplace에서 Neon Postgres를 연결합니다.
3. Vercel이 추가한 `BLOB_READ_WRITE_TOKEN`, `POSTGRES_URL` 환경변수를 확인합니다.
4. 필요하면 Neon SQL Editor에서 `vercel-postgres-schema.sql` 내용을 실행합니다. 앱도 첫 요청 때 테이블을 자동 생성합니다.
5. Vercel 환경변수에 아래 값을 넣습니다.

```bash
POSTGRES_URL=your_neon_or_vercel_postgres_url
BLOB_READ_WRITE_TOKEN=your_vercel_blob_token
GEMINI_API_KEY=your_key_here
```

Blob과 Postgres 키는 서버에서만 사용해야 하며 브라우저 코드에 넣으면 안 됩니다.

## Vercel 웹 배포

터미널 없이 Vercel 사이트에서 배포할 수 있습니다.

1. 프로젝트를 GitHub, GitLab, Bitbucket 중 하나에 올립니다.
2. Vercel Dashboard에서 New Project를 누릅니다.
3. 저장소를 선택합니다.
4. Root Directory를 `persona-research-site`로 지정합니다.
5. Environment Variables에 Blob/Postgres/Gemini 값을 넣습니다.
6. Deploy를 누릅니다.

Vercel에서는 `public` 폴더가 정적 사이트로 배포되고, `/api/*` 요청은 `api/[...path].js`를 통해 서버리스 함수로 처리됩니다.

## 데이터셋

앱은 Hugging Face datasets-server의 공개 rows API에서 `nvidia/Nemotron-Personas-Korea` 후보 row를 가져와 필터링합니다. 이 데이터는 실제 개인 정보가 아니라 한국 인구통계 기반 합성 페르소나입니다.
