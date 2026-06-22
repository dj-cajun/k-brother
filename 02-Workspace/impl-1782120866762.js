```markdown
# 교민 사이트 연동 카페 스아다 쿠폰 O2O MVP 시스템 아키텍처 명세서

> Document Owner: CTO
> Version: 1.0
> Status: Approved for MVP Build

---

## 0. 시스템 개요

교민 커뮤니티 사이트 배너 유입을 통해 회원에게 **10% 할인 카페 스아다 쿠폰**을 발급하고, 현장에서 **3분 한시 만료 보안 QR**로 사용·소멸 처리하며, 대리점 실시간 알림 및 운영자 Discord Webhook 알림까지 처리하는 O2O MVP 시스템.

### 0.1 핵심 설계 원칙

| 원칙 | 설명 |
|------|------|
| 보안 QR | QR은 단순 ID가 아닌 **서명된(JWT) 1회성 토큰**, 3분 TTL |
| 원자적 소멸 | 쿠폰 소멸은 DB 트랜잭션 + 상태머신으로 **이중 사용 방지** |
| 실시간성 | WebSocket(Socket.IO)로 대리점 알림, Discord Webhook로 운영자 알림 |
| 멱등성 | 스캔 검증 API는 멱등 처리 (중복 스캔 무해화) |

### 0.2 기술 스택

```
Runtime    : Node.js 20 LTS
Framework  : Express 4
Realtime   : Socket.IO 4
DB         : PostgreSQL 15 (Prisma ORM 권장, 본 MVP는 pg 직접 사용)
Auth       : JWT (jsonwebtoken)
QR         : qrcode (생성), JWT 서명 토큰
Notify     : Discord Webhook (axios)
```

---

## 1. 디렉토리 구조

```
/
├── 01-Blueprints/
│   ├── DB_SPEC.md            # 전체 DB 스키마 명세
│   └── NOTIFICATION_SPEC.md  # 알림(실시간/Webhook) 명세
└── 02-Workspace/
    ├── package.json
    ├── .env.example
    ├── sql/
    │   └── schema.sql
    └── src/
        ├── config.js
        ├── db.js
        ├── server.js
        ├── realtime.js
        ├── services/
        │   ├── couponService.js
        │   ├── qrService.js
        │   └── notifyService.js
        ├── middleware/
        │   └── auth.js
        └── routes/
            ├── auth.routes.js
            ├── wallet.routes.js
            ├── coupon.routes.js
            └── agent.routes.js
```

---

## 2. 컴포넌트 다이어그램

```
[교민사이트 배너]
       │ click
       ▼
┌──────────────────┐   signup   ┌──────────────────────┐
│  유저 웹 (Wallet) │──────────▶│  Auth / Coupon API     │
│   My Wallet UI   │            │  (Express)             │
└──────────────────┘            └──────────┬───────────┘
       │ use coupon                         │
       ▼ generate QR (JWT 3min TTL)         ▼
┌──────────────────┐            ┌──────────────────────┐
│  3분 QR 화면      │            │   PostgreSQL          │
└──────────────────┘            │  users / coupons /    │
       │ scan                   │  transactions         │
       ▼                        └──────────┬───────────┘
┌──────────────────┐  verify+kill          │
│  대리점 웹 (Agent)│──────────────────────▶│
│  카메라 QR 스캔   │◀───── Socket.IO ───────┤ "음료 지급" push
└──────────────────┘                        │
                                            ▼
                                  ┌──────────────────┐
                                  │ Discord Webhook   │ ← 운영자(대표) 알림
                                  └──────────────────┘
```

---

## 3. 상태머신 (쿠폰 라이프사이클)

```
ISSUED ──(use 요청)──▶ PENDING(QR active 3min)
   ▲                        │
   │ TTL 만료 (재사용 가능)  │ scan 검증 성공
   └────────────────────────┤
                            ▼
                        REDEEMED (소멸/최종)
```

- `ISSUED` : 지갑에 발급된 상태
- `PENDING` : QR 생성됨, 3분 타이머 작동. 만료 시 다시 `ISSUED`로 복귀 가능
- `REDEEMED` : 스캔 완료, **소멸(최종 불변)**

---

## 4. API 명세 요약

| Method | Path | 설명 | 인증 |
|--------|------|------|------|
| POST | `/api/auth/signup` | 회원가입 + 환영 쿠폰 자동 발급 | - |
| POST | `/api/auth/login` | 로그인(JWT 발급) | - |
| GET  | `/api/wallet` | My Wallet 쿠폰 목록 | User |
| POST | `/api/coupons/:id/qr` | 3분 QR 토큰 생성 | User |
| POST | `/api/agent/verify` | QR 검증 + 소멸 처리 | Agent |

---

# 01-Blueprints/DB_SPEC.md

```markdown
# DB 명세서 — Cafe Suada Coupon O2O MVP

## ERD 개요
users (1) ── (N) coupons (1) ── (1) transactions

## 1. users — 교민 유저
| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | UUID | PK, default gen_random_uuid() | 유저 ID |
| email | VARCHAR(255) | UNIQUE, NOT NULL | 로그인 이메일 |
| password_hash | VARCHAR(255) | NOT NULL | bcrypt 해시 |
| name | VARCHAR(100) | NOT NULL | 이름 |
| referral_source | VARCHAR(50) | NULL | 유입 경로(예: gyomin_banner) |
| created_at | TIMESTAMPTZ | default now() | 생성일 |

## 2. agents — 대리점 계정
| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | UUID | PK | 대리점 ID |
| store_name | VARCHAR(150) | NOT NULL | 매장명 |
| login_id | VARCHAR(100) | UNIQUE, NOT NULL | 로그인 ID |
| password_hash | VARCHAR(255) | NOT NULL | bcrypt 해시 |
| created_at | TIMESTAMPTZ | default now() | |

## 3. coupons — 쿠폰
| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | UUID | PK | 쿠폰 ID |
| user_id | UUID | FK→users.id, NOT NULL | 소유 유저 |
| code | VARCHAR(20) | UNIQUE, NOT NULL | 사람 식별용 코드 |
| title | VARCHAR(150) | NOT NULL | "카페 스아다 10% 할인" |
| discount_rate | INT | NOT NULL default 10 | 할인율(%) |
| status | VARCHAR(20) | NOT NULL default 'ISSUED' | ISSUED/PENDING/REDEEMED |
| qr_jti | VARCHAR(64) | NULL | 현재 활성 QR 토큰 jti |
| qr_expires_at | TIMESTAMPTZ | NULL | QR 만료 시각(3분) |
| redeemed_at | TIMESTAMPTZ | NULL | 소멸 시각 |
| created_at | TIMESTAMPTZ | default now() | 발급일 |

CHECK (status IN ('ISSUED','PENDING','REDEEMED'))

## 4. transactions — 트랜잭션(지급 이력)
| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | UUID | PK | 트랜잭션 ID |
| coupon_id | UUID | FK→coupons.id, UNIQUE | 1쿠폰 1지급 |
| agent_id | UUID | FK→agents.id | 처리 대리점 |
| user_id | UUID | FK→users.id | 유저 |
| redeemed_at | TIMESTAMPTZ | default now() | 지급 처리 시각 |
| notified_discord | BOOLEAN | default false | Webhook 발송 여부 |

## 인덱스
- coupons(user_id), coupons(status), coupons(qr_jti)
- transactions(agent_id), transactions(coupon_id UNIQUE)

## 상태 전이 무결성
- ISSUED→PENDING : QR 생성
- PENDING→REDEEMED : 스캔 검증 (UPDATE ... WHERE status='PENDING' 원자성 보장)
- PENDING→ISSUED : qr_expires_at 만료 시 재사용 허용
```

---

# 01-Blueprints/NOTIFICATION_SPEC.md

```markdown
# 알림 명세서 — Realtime & Discord Webhook

## 1. 실시간 알림 (Socket.IO)
- 네임스페이스: