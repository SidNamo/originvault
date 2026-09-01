# OriginVault

OriginVault는 개인 서버에서 운영하는 원본 파일 금고입니다. 업로드 바이트를 변환하지
않고 보관하며, 파일 메타데이터를 색인해 인증된 파일 탐색, 공개 공유 링크, 범위 제한
 WebDAV를 제공하며 quota가 설정된 계정은 WebDAV 클라이언트에서 사용량과 남은 용량을
 확인할 수 있습니다. 원본 파일은 호스트 디렉터리에, 사용자·공유·업로드 상태와
색인은 PostgreSQL에 보관합니다.

## 배포 구조

운영 경로는 Nginx Proxy Manager(NPM) -> frontend -> backend -> PostgreSQL입니다.
Compose는 `.env`의 bind 설정에 따라 frontend만 host에 공개합니다. backend와
PostgreSQL은 host 포트를 열지 않으며 직접 외부에 공개하면 안 됩니다.

NPM에서 TLS를 종료하고 Force SSL을 켜며, 외부 firewall/NAT에는 NPM의 HTTPS 포트만
허용합니다.

| NPM 실행 위치 | upstream host | upstream port |
| --- | --- | --- |
| Host 프로세스 | `FRONTEND_BIND_ADDRESS` | `FRONTEND_PORT` |
| Docker 컨테이너 | `originvault_default` 네트워크의 `frontend` | `80` |

Docker NPM은 `originvault_default` 네트워크에 연결한 뒤 `frontend:80`을 upstream으로
사용합니다. 브라우저 origin과 내부 upstream을 포함한 모든 주소는 `.env`에만 입력합니다.

## 환경 변수

`.env`가 배포 설정의 단일 기준입니다. 각 변수 옆에는 입력 기준을 주석으로 남겼습니다.
파일 권한은 `600`으로 유지하고 Git에 포함하지 않습니다. API 허용 origin은
`PUBLIC_URL`에서 자동으로 파생하므로 별도 CORS 변수는 사용하지 않습니다.
Expo app의 API origin은 `app/.env.example`을 복사해 만든 `app/.env`의
`EXPO_PUBLIC_API_URL`로 별도 관리합니다.

| 변수 | 배포 시 | 입력 값 |
| --- | --- | --- |
| `POSTGRES_DB` | 고정 | DB 이름. 최초 배포 뒤에는 변경하지 않습니다. |
| `POSTGRES_USER` | 고정 | DB 로그인 이름. 최초 배포 뒤에는 변경하지 않습니다. |
| `POSTGRES_PASSWORD` | 예 | 강한 DB 비밀번호. 기존 서버에서는 PostgreSQL 내부 비밀번호를 먼저 교체한 뒤 `.env`를 바꿉니다. |
| `DATABASE_URL` | 예 | backend 전용 PostgreSQL connection string입니다. POSTGRES 설정과 일치시킵니다. |
| `JWT_SECRET` | 예 | `openssl rand -hex 32`의 고유 출력값. 변경하면 모든 로그인 세션이 만료됩니다. |
| `SHARE_SECRET` | 예 | JWT와 다른 `openssl rand -hex 32` 출력값. 새 공개 링크 서명에 사용합니다. |
| `LEGACY_SHARE_SECRET` | 아니오 | 예전 share/JWT key로 서명된 공개 링크를 임시 유지할 때만 입력합니다. |
| `PUBLIC_URL` | 예 | 브라우저가 사용할 정확한 origin입니다. scheme, host, port를 모두 포함하며 CORS와 공유 URL 기준이 됩니다. |
| `BACKEND_BIND_ADDRESS` | 예 | backend process bind 주소입니다. |
| `BACKEND_PORT` | 예 | backend process port입니다. |
| `BACKEND_HEALTHCHECK_HOST` | 예 | backend container 내부 healthcheck 대상입니다. |
| `BACKEND_UPSTREAM` | 예 | frontend reverse proxy가 사용할 backend origin입니다. |
| `FRONTEND_BIND_ADDRESS` | 예 | frontend host bind 주소입니다. |
| `FRONTEND_PORT` | 예 | NPM 또는 browser가 연결할 frontend port입니다. |
| `MAX_UPLOAD_BYTES` | 기본값 | 파일 하나당 업로드 상한 byte 값입니다. `10737418240`은 10 GiB입니다. |
| `DEFAULT_STORAGE_QUOTA_BYTES` | 기본값 | 새 사용자 기본 quota byte 값입니다. 기존 사용자 quota는 바뀌지 않습니다. |
| `LOG_LEVEL` | 기본값 | 운영은 `info`를 사용합니다. 장애 조사 때만 `debug` 또는 `trace`를 사용합니다. |
| `LOG_RETENTION_DAYS` | 기본값 | UTC 일별 로그 보관 수를 양의 정수로 입력합니다. |

신규 설치:

```sh
cp .env.example .env
chmod 600 .env
# .env.example의 필수 값을 모두 입력합니다.
docker compose up -d --build
```

필수 secret 또는 network 설정이 비어 있으면 Compose는 시작하지 않습니다.

## 직접 HTTP 접속

NPM 없이 직접 접속할 때도 `PUBLIC_URL`, frontend bind 주소와 port를 `.env`에 정확히
입력합니다. HTTP origin은 literal IP에만 허용됩니다. 일반 도메인은
HTTPS를 사용해야 합니다. Router와 firewall에서는 frontend port의 접근 범위를 신뢰하는
network로 제한합니다.

## 기존 서버 업데이트

업데이트 전 `data/`를 백업합니다. 기존 `POSTGRES_PASSWORD`, `JWT_SECRET`,
`SHARE_SECRET`, `FRONTEND_PORT`는 임의로 바꾸지 않습니다. DB 연결, 로그인 세션,
공개 링크 또는 NPM/LAN upstream이 끊길 수 있습니다.

```sh
git pull --ff-only
docker compose up -d --build
docker compose logs -f backend
```

이전 버전에서 `SHARE_SECRET`이 비어 있었다면 기존 공개 링크는 JWT key로 서명되어
있습니다. 이 경우 새 `SHARE_SECRET`을 생성하고 `LEGACY_SHARE_SECRET`에 이전
`JWT_SECRET`을 입력합니다. 기존 링크를 모두 폐기하거나 재발행한 뒤에만
`LEGACY_SHARE_SECRET`을 비웁니다.

## 데이터와 복구

| 경로 | 내용 | 백업 방식 |
| --- | --- | --- |
| `data/files/` | 원본 파일 바이트 | filesystem snapshot, `rsync` 등 |
| `data/postgresql/` | PostgreSQL 물리 데이터 | 실행 중에는 복사하지 않고 `pg_dump` 사용 |
| `data/logs/` | 일별 JSON 로그 | 운영 보관 정책에 따라 선택 |

backend는 PostgreSQL advisory lock과 파일 변경 저널로 DB 색인과 파일 작업을 일관되게
처리합니다. 같은 PostgreSQL 및 `data/` 경로에 backend를 두 개 이상 실행하지 않습니다.

## 데이터베이스 migration

시작 시 `schema_migrations`를 확인하고 미적용 migration을 transaction 안에서 실행합니다.
`docker compose up -d --build`가 일반적인 migration 배포 절차입니다. 새 DB 변경은 새
버전 migration으로 추가하고, 이미 운영에 적용된 migration은 수정하지 않습니다.

## 운영 확인

```sh
docker compose ps
docker compose logs --tail=200 backend
curl --fail "${PUBLIC_URL}/api/health"
```

health endpoint는 `200`을 반환해야 합니다. 인증 업로드, 공개 공유 링크, NPM HTTPS
접속을 확인하면 인증·저장소·프록시 변경 후의 핵심 경로를 검증할 수 있습니다.

## 로컬 검증

```sh
(cd backend && npm ci && npm run build && npm test)
(cd frontend && npm ci && npm run build)
```

모바일 Expo 프로젝트는 Compose 배포와 분리되어 있으며
`(cd app && npm run typecheck)`로 확인합니다.
