# OriginVault

OriginVault는 개인 서버에서 운영하는 원본 파일 금고입니다. 업로드 바이트를 변환하지
않고 보관하며, 파일 메타데이터를 색인해 인증된 파일 탐색, 공개 공유 링크, 범위 제한
 WebDAV를 제공하며 quota가 설정된 계정은 WebDAV 클라이언트에서 사용량과 남은 용량을
 확인할 수 있습니다. 원본 파일은 호스트 디렉터리에, 사용자·공유·업로드 상태와
색인은 PostgreSQL에 보관합니다.

## 배포 구조

운영 경로는 Nginx Proxy Manager(NPM) -> frontend -> backend -> PostgreSQL입니다.
Compose는 frontend만 `.env`의 `FRONTEND_PORT`로 host에 공개합니다. backend와
PostgreSQL은 host 포트를 열지 않으며 직접 외부에 공개하면 안 됩니다.

NPM에서 TLS를 종료하고 Force SSL을 켜며, 외부 firewall/NAT에는 NPM의 HTTPS 포트만
허용합니다.

| NPM 실행 위치 | upstream host | upstream port |
| --- | --- | --- |
| Host 프로세스 | OriginVault host | `FRONTEND_PORT` |
| Docker 컨테이너 | `originvault_default` 네트워크의 `frontend` | `80` |

Docker NPM은 `originvault_default` 네트워크에 연결한 뒤 `frontend:80`을 upstream으로
사용합니다. Docker 내부 backend와 PostgreSQL 주소는 Compose에서 고정하며 `.env`에는
외부에서 선택해야 하는 값만 입력합니다.

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
| `JWT_SECRET` | 예 | `openssl rand -hex 32`의 고유 출력값. 변경하면 모든 로그인 세션이 만료됩니다. |
| `SHARE_SECRET` | 예 | JWT와 다른 `openssl rand -hex 32` 출력값. 새 공개 링크 서명에 사용합니다. |
| `LEGACY_SHARE_SECRET` | 아니오 | 예전 share/JWT key로 서명된 공개 링크를 임시 유지할 때만 입력합니다. |
| `PUBLIC_URL` | 예 | 브라우저가 사용할 정확한 origin입니다. scheme, host, port를 모두 포함하며 CORS와 공유 URL 기준이 됩니다. |
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

NPM 없이 직접 접속할 때도 `PUBLIC_URL`과 frontend port를 `.env`에 정확히
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
| `data/files/<storage-key>/` | 사용자별 원본 파일 바이트 | filesystem snapshot, `rsync` 등 |
| `data/files/.originvault-thumbnails/` | SHA-256별 재생성 가능한 이미지·동영상·PDF 썸네일과 이미지 상세 미리보기 | 백업 선택 사항 |
| `data/postgresql/` | PostgreSQL 물리 데이터 | 실행 중에는 복사하지 않고 `pg_dump` 사용 |
| `data/logs/` | 일별 JSON 로그 | 운영 보관 정책에 따라 선택 |

원본 파일은 미리보기 때문에 변환하거나 교체하지 않습니다. 이미지 썸네일은 WebP,
동영상 대표 프레임과 PDF 첫 페이지 썸네일은 JPEG로 만들고, 브라우저가 직접 표시하지 못하는 이미지는 최대
2560px WebP 상세 미리보기를 별도 생성합니다. HEIC/HEIF, JPEG XL, JPEG 2000, TIFF,
PSD/PSB, XCF, EXR/HDR, TGA, DDS, QOI, DICOM, PNM/PCX/FITS와 주요 카메라 RAW 형식을
지원합니다. SVG는 sandbox가 적용된 원본을 표시하며 압축 SVGZ는 inline 표시하지
않습니다.

파생 캐시는 SHA-256을 키로 `data/files/.originvault-thumbnails/v1/` 아래에 저장합니다.
backend는 시작 후 기존 활성·휴지통 파일의 누락 썸네일을 비동기로 채웁니다. 이후
6시간마다 누락 썸네일 백필을 먼저 실행하고 캐시를 정리합니다. 어떤 활성·휴지통
파일에서도 참조하지 않고 마지막 생성·재사용 후 24시간이 지난 캐시만 삭제합니다.
동영상은 FFmpeg로 최대 512px 대표 프레임을 추출해 `<sha256>.video.jpg`로 저장합니다.
일반·resumable·공개 공유·WebDAV 업로드에서 미리 생성하며, 캐시가 없는 동영상은
목록 요청 시 생성한 뒤 이미지를 응답합니다. 보이는 항목의 요청은 백필 대기 작업보다
우선 처리하고, 같은 파일의 백필이 이미 대기 중이면 그 작업의 우선순위를 올립니다.
이미 실행 중인 렌더링은 완료 후 다음 작업을 시작합니다.

일반·공개 공유·휴지통 목록의 이미지·동영상·PDF는 같은 이미지 로딩 경로를 사용합니다.
화면 근처에서만 불러오고, 벗어나면 전송을 중단하며, 다시 들어오면 HTTP Range로
이어받습니다. 완료한 썸네일은 메모리 캐시(최대 256 MiB / 5,000개)에서 재사용합니다.
새로고침·로그아웃·캐시 한도에 따른 제거 후에는 다시 요청할 수 있습니다.

이미지·동영상·PDF 렌더러는 동시에 최대 2개, 대기열은 최대 32개로 제한합니다.
FFmpeg는 검증된 원본 파일 핸들과 제한된 protocol/컨테이너 형식으로 실행하며,
ImageMagick은 coder allowlist와 시간·메모리·디스크·이미지 크기 제한 안에서 동작합니다.

backend는 PostgreSQL advisory lock과 파일 변경 저널로 DB 색인과 파일 작업을 일관되게
처리합니다. 같은 PostgreSQL 및 `data/` 경로에 backend를 두 개 이상 실행하지 않습니다.

### WebDAV 원본 메타데이터

PUT는 수신한 바이트의 SHA-256·크기를 계산하고 ExifTool로 MIME·EXIF·미디어 정보를
읽습니다. 덮어쓰기는 새 바이트에서 메타데이터를 다시 추출합니다. EXIF 촬영일과 별도
시간대 오프셋, QuickTime 생성일을 원본 생성일에 반영하며, 기존 색인에서 누락된
촬영일도 서버 시작 시 저장된 메타데이터로 보완합니다. 시간대가 없는 EXIF 날짜는
UTC 기준으로 색인하되 추출한 원문 날짜를 메타데이터에 보관합니다.

원본 파일 수정시각은 클라이언트의 `X-OC-MTime`, `X-Upload-MTime`, `X-File-MTime`,
`X-Last-Modified`, `Last-Modified` 헤더에서 읽습니다. PUT 이후 `PROPPATCH`로 전달하는
`DAV:creationdate`, `DAV:getlastmodified`, Microsoft `Win32CreationTime`·
`Win32LastModifiedTime`도 지원합니다. 클라이언트 파일 생성일은 `WebDAV:CreationDate`에
별도로 보관하며 내장 촬영일을 덮어쓰지 않습니다. 날짜 속성 갱신과 MOVE는 원본 바이트를
변경하지 않고, MOVE는 저장된 원본 날짜·메타데이터를 유지합니다.

클라이언트가 수정시각을 전달하지 않으면 원본 수정일은 알 수 없음으로 보관합니다.
서버 업로드 시간을 원본 수정일로 기록하지 않습니다. PROPFIND/GET은 알려진 원본 날짜를
우선 반환하고, 없으면 서버 색인 날짜를 사용합니다. 지원하지 않는 PROPPATCH 속성이
섞인 요청은 전체를 적용하지 않고 207 응답의 각 속성 상태로 실패를 알립니다.

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

Backend 테스트에는 Node.js 24, FFmpeg(`libx264`/`mjpeg` 포함), ExifTool이 필요합니다.
이미지/PDF 실제 변환에는 배포 Dockerfile의 ImageMagick 모듈과 Poppler도 설치합니다.

```sh
(cd backend && npm ci && npm run build && npm test)
(cd frontend && npm ci && npm run build)
```

WebDAV·동영상 통합 테스트는 PostgreSQL의 `CREATEDB` 권한이 있는 시험용 연결을 지정합니다.
별도의 임시 DB를 생성해 실제 backend를 실행하고, 테스트 종료 시 그 DB를 삭제합니다.
PostgreSQL 서버에는 `pgcrypto` 확장이 설치되어 있어야 합니다.

```sh
(cd backend && ORIGINVAULT_TEST_DATABASE_URL='postgresql://tester:password@127.0.0.1:5432/postgres' npm run test:integration)
```

모바일 Expo 프로젝트는 Compose 배포와 분리되어 있으며
`(cd app && npm run typecheck)`로 확인합니다.
