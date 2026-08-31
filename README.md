# OriginVault

사진, 동영상, 문서 등 모든 파일을 업로드 시점의 바이트 그대로 보관하고, 필요할
때 명시적으로 텍스트 편집이나 WebDAV 덮어쓰기를 할 수 있는 개인 파일 서비스입니다.

## MVP 기능

- 회원가입 / 로그인 (JWT, bcrypt)
- 반응형 파일 브라우저와 사이드바 전체 폴더 트리
- 폴더 생성, 이름 변경, 삭제 및 탐색
- 다중 파일 및 폴더 전체 원본 업로드
- 파일별 전송률, 폴더별 처리 현황, 대기/진행/완료/실패 필터와 취소 가능한 업로드 큐
- EXIF/IPTC/XMP 및 일반 파일 메타데이터 조회
- SHA-256 무결성 표시
- 인증된 원본 다운로드
- 이미지·영상·음성·PDF·텍스트 미리보기, 같은 폴더 이전/다음 탐색과 자막 연결
- UTF-8, UTF-16, 한·중·일 레거시 인코딩을 선택할 수 있는 텍스트/코드 편집
- 공개 링크 공유, 접속 IP별 통계, 공유 취소, 링크 변경, 재공유와 내역 숨김
- 폴더 범위 WebDAV 토큰과 `/webdav/` 읽기/쓰기 연결
- 사용자 이름·비밀번호 설정, 첫 계정 관리자 자동 지정
- 회원가입 ON/OFF, 관리자 사용자 관리와 회원별 스토리지 할당량

## 실행

```bash
cp .env.example .env
# JWT_SECRET, SHARE_SECRET, POSTGRES_PASSWORD를 반드시 변경하세요.
docker compose up --build
```

- Web: <http://localhost:3000>
- API health: <http://localhost:3000/api/health>
- 원본 저장소: `./DATA/files/{storage-key}/...` (`storage-key`는 최초 사용자 이름으로 생성 후 유지)
- PostgreSQL 데이터: `./DATA/postgresql/`

백엔드는 파일 교체 복구를 위해 데이터베이스 단위의 단일 인스턴스 잠금을
사용합니다. 같은 PostgreSQL과 `DATA`를 사용하는 backend 복제본을 동시에
실행하지 마세요. Compose 기본 구성은 backend 한 개만 실행합니다.
Nginx는 요청 본문을 별도로 제한하지 않으며 업로드와 편집 크기는 백엔드의
`MAX_UPLOAD_BYTES`와 사용자 할당량이 스트리밍 중 강제합니다.
backend 컨테이너는 시작할 때 `DATA/files` 루트와 `DATA/logs`의 소유권만
컨테이너의 `node` 사용자에 맞춘 뒤 권한을 낮춰 실행합니다. PostgreSQL 물리
데이터인 `DATA/postgresql`의 소유권은 변경하지 않습니다.

이전 이미지에서 `EACCES: permission denied, open '/data/logs/...'`가 발생했다면
한 번만 다음 명령으로 기존 로그 소유권을 복구한 뒤 backend를 재빌드하세요.

```bash
sudo chown 1000:1000 DATA/files
sudo chown -R 1000:1000 DATA/logs
docker compose up -d --build backend frontend
```

## 로그

백엔드는 TRACE, DEBUG, INFO, WARN, ERROR, FATAL 레벨의 JSON 구조화 로그를
Docker 표준 출력과 호스트의 `./DATA/logs`에 동시에 기록합니다. 기본 설정은 다음과
같으며 `.env`에 이미 포함되어 있습니다.

```dotenv
LOG_LEVEL=trace
LOG_RETENTION_DAYS=7
```

로그 파일은 UTC 날짜를 포함한 `DATA/logs/originvault-YYYY-MM-DD.log` 형식입니다.
현재 날짜를 포함해 최근 7개 UTC 날짜의 로그를 유지하며, 서버 시작 및 날짜가
바뀔 때 더 오래된 파일을 자동 삭제합니다.

```bash
# Docker 실시간 로그
docker compose logs -f backend

# 날짜별 파일 로그
tail -f DATA/logs/originvault-$(date -u +%F).log
```

HTTP 요청 ID, 상태 코드, 처리시간, 인증 결과, 폴더 작업, 업로드 저장 단계,
크기, SHA-256, 메타데이터 추출 결과 및 서버/DB 생명주기가 기록됩니다.
비밀번호, JWT, Authorization 헤더와 EXIF 원문은 기록하지 않습니다.

현재 Compose는 PostgreSQL, backend, frontend만 실행합니다. `app/`은 향후
가상 환경에서 설치 파일을 빌드할 때까지 개발 대상에서 제외되어 있습니다.

## 장애 시 직접 복구

PostgreSQL은 로그인, 파일 인덱스, 공유와 업로드 상태 등 서비스 데이터를 보관합니다.
현재 파일 바이트는 Docker 볼륨 내부가 아닌 호스트의 일반 디렉터리에 안정적인 저장 키와 실제
폴더/파일 이름으로 저장됩니다.

```text
DATA/files/{storage-key}/{웹에서 만든 폴더}/{읽을 수 있는 파일 이름}
```

따라서 PostgreSQL이나 backend 컨테이너가 손상되어도 Compose를 내린 뒤
`DATA/files/`를 일반 파일 탐색기, `cp`, `rsync` 등으로 직접 열어 복구할 수
있습니다. PostgreSQL의 물리 데이터는 `DATA/postgresql/`, 로그는 `DATA/logs/`에
분리됩니다. 서비스가 실행 중일 때 PostgreSQL 폴더를 단순 복사하는 대신 DB
dump를 사용하고, 원본은 `DATA/files/`를 별도로 백업하세요.

## 업로드 원본·EXIF 보존 범위

OriginVault는 업로드 본문을 변환 없이 스트리밍 저장합니다. ExifTool은 저장
후 메타데이터를 읽기만 하며 파일을 수정하지 않습니다. 다운로드 역시 저장된
파일을 그대로 전송하므로, 업로드 직후에는 내장 EXIF와 모든 바이너리
메타데이터가 유지됩니다.

텍스트 편집기에서 저장하거나 쓰기 가능한 WebDAV 연결로 `PUT`하면 사용자가
요청한 새 바이트로 해당 파일을 교체합니다. 이 경우 SHA-256, 크기, 수정 시각과
추출 메타데이터가 함께 갱신되며 이전 바이트를 버리는 명시적 수정 작업입니다.
WebDAV 업로드의 `X-OC-MTime`, `X-Upload-MTime`, `X-File-MTime`,
`X-Last-Modified`, `Last-Modified`가 유효하면 원본 파일 수정 시각을 파일시스템과
DB에 함께 보존하며, `PROPFIND`와 다운로드 응답에도 같은 시각을 반환합니다.

> 브라우저/OS 파일 선택기가 편집본이나 변환본을 넘기면 서버는 기기 원본에
> 접근할 수 없습니다. 특히 iOS 사진 선택 설정은 향후 네이티브 앱에서
> `current/original` 표현을 명시적으로 요청해야 합니다.

설계 세부사항은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)를 참고하세요.

## 공유와 WebDAV

내 파일에서 하나의 파일 또는 폴더를 선택해 공개 링크를 만들 수 있습니다.
공유 화면에서 링크별 열람, 다운로드, 접속 IP와 최근 액션을 확인할 수 있습니다.
공유 취소는 이후 요청을 차단하고, 링크 변경은 이전 주소를 무효화하며, 만료·취소
항목은 새 행과 새 주소로 재공유할 수 있습니다. 내역 삭제는 링크를 취소하고
목록에서 논리적으로 숨기지만 통계와 대상 이름 스냅샷은 보존합니다. 이미 시작된
다운로드는 취소나 링크 변경 뒤에도 완료될 수 있습니다. WebDAV는 계정 비밀번호
대신 한 번만 표시되는 전용 토큰을 사용하며, 전체 저장소 또는 선택한 폴더에
읽기/쓰기 범위를 지정합니다. 토큰을 재발행하면 기존 비밀값은 즉시 무효화되고
새 값이 한 번만 표시됩니다. 기본
주소는 `/webdav/`이고 외부 연결에는 HTTPS 사용을 권장합니다. 자세한 보안 기준은
[docs/SHARING.md](docs/SHARING.md)에 정리되어 있습니다.

## 미리보기와 텍스트 편집

- 브라우저가 지원하는 이미지, 영상, 음성 코덱과 PDF를 원본 스트림으로 표시합니다.
- 영상과 음성에는 같은 이름 계열의 VTT, SRT, ASS, SSA, LRC 자막을 자동 연결할 수 있습니다.
- 텍스트와 코드 확장자는 대소문자와 관계없이 읽고 편집할 수 있습니다.
- 인코딩은 UTF-8, UTF-16 LE/BE, EUC-KR, CP949, Shift_JIS, EUC-JP,
  GB18030, Big5, Windows-1252, ISO-8859-1을 지원합니다.
- 파일 크기에 별도 미리보기 제한은 없지만, 브라우저 메모리보다 큰 텍스트는
  느려지거나 열리지 않을 수 있습니다.
- 저장 시 `If-Match` SHA-256 ETag를 확인하므로 다른 작업이 먼저 파일을
  변경했다면 덮어쓰지 않고 다시 열도록 요청합니다.
- 브라우저가 해당 미디어 컨테이너나 내부 코덱을 지원하지 않으면 원본 다운로드를 사용해야 합니다.

파일 교체 작업은 `DATA/files/.originvault-preview-staging`과
`DATA/files/.dav-staging`의 내구성 저널을 사용합니다. 시작 시 DB의 SHA-256과
저널을 대조해 완료 또는 롤백하며, 안전하게 판단할 수 없는 저널이 있으면 자동으로
서비스를 열지 않습니다. 이 경우 로그의 `mutation_journal_*` 이벤트를 확인한 뒤
원본과 DB 상태를 수동 점검해야 합니다.

## 개발 검증

```bash
cd backend && npm ci && npm test && npm run build
cd ../frontend && npm ci && npm run build
```

## 유사 오픈소스와의 차이

- **Immich**: 사진/동영상 중심의 완성도 높은 대안이며 원본과 생성물을 분리합니다.
- **Nextcloud**: 범용 파일/폴더와 폴더 압축 다운로드가 이미 필요한 경우 좋은 대안입니다.
- **OriginVault**: 단순한 물리 경로, 범용 파일, 업로드 원본 보존과 명시적 수정 경계를 제품 중심에 둔 맞춤 구현입니다.
