# kimP (김치 프리미엄 차익거래 보조 시스템)

서로 다른 암호화폐 거래소 간의 가격 차이(김치 프리미엄 또는 역프리미엄)를 이용한 차익거래 기회를 포착하고, 이를 관리하며 알림을 제공하는 시스템입니다. 본 프로젝트는 **시뮬레이션 기반**의 차익거래 로직을 포함하며, 실제 자금으로 거래하는 기능은 포함되어 있지 않거나 사용 시 각별한 주의가 필요합니다.

## 주요 기능

- 여러 거래소(현재 업비트 및 바이낸스)의 특정 암호화폐 페어 가격 정보 실시간 수집.
- 수집된 가격을 바탕으로 차익거래 기회(스프레드 및 **예상** 순수익률) 계산.
- 미리 정의된 조건 충족 시 차익거래 사이클 시작 (시뮬레이션).
- 차익거래 사이클은 고프리미엄 단계와 저프리미엄 단계로 구성될 수 있으며, 각 단계는 다음을 포함합니다:
  - 초기 거래 실행 (매수/매도) 및 코인 전송 시뮬레이션.
  - 해당 단계의 **예상 순수익** 계산 (송금 시간 동안의 가격 변동은 현재 시뮬레이션에서 직접 반영하지 않음).
- 각 사이클의 진행 상황, **예상** 손익, 수수료 등의 상세 정보를 데이터베이스에 기록.
- **이전 차익거래 사이클의 순손익을 반영하여 다음 거래의 투자 자본금을 동적으로 조절.**
- **저프리미엄 탐색 시, 경과 시간에 따라 목표 수익률을 점진적으로 하향 조정하며, 설정된 최대 탐색 기간 초과 시 사용자 알림 또는 정의된 정책에 따라 사이클을 종료하는 "소프트 타임아웃" 로직 적용.** (사용자 상호작용 기능은 추후 구현 예정)
- 사이클 완료, 주요 오류 발생, 또는 사용자 결정이 필요한 상황 발생 시 텔레그램으로 알림 전송.

## 기술 스택

- **프레임워크**: NestJS (Node.js)
- **언어**: TypeScript
- **데이터베이스**: MySQL (TypeORM 사용)
- **실시간 데이터 수집**: WebSocket
- **주요 라이브러리**:
  - `rxjs`: 반응형 프로그래밍 (이벤트 스트림 처리)
  - `axios`: HTTP 클라이언트
  - `@nestjs/config`: 환경 변수 및 설정 관리
  - `@nestjs/schedule`: 스케줄링 작업

## 아키텍처 및 기능 정리

kimP 시스템은 기능별 책임 분리를 위해 모듈화된 아키텍처를 따릅니다. 각 기능은 독립적인 모듈로 구성되어 유지보수성과 확장성을 높였습니다.

### **1. 데이터 수집 계층 (`MarketDataModule`, `WsModule`)**

- **역할**: 모든 차익거래 판단의 기초가 되는 실시간 시장 데이터를 수집하고 전파합니다.
- **주요 서비스**:
  - `PriceFeedService`: 업비트, 바이낸스와의 WebSocket 연결을 유지하며, 실시간 시세 데이터를 수신하여 RxJS `Subject`를 통해 시스템 내부에 방송합니다.
  - `WsService`: `PriceFeedService`가 방송하는 가격 데이터를 구독하여, 차익거래 로직의 총괄 책임자인 `ArbitrageFlowManagerService`에게 전달하는 진입점(Entrypoint) 역할을 합니다.

### **2. 핵심 로직 계층 (`ArbitrageModule`)**

- **역할**: 차익거래 기회를 판단하고, 전체 사이클의 흐름을 관리하며, 단계별 로직을 실행하는 시스템의 심장부입니다.
- **주요 서비스**:
  - `ArbitrageFlowManagerService` (Cycle Orchestrator): 전체 흐름을 지휘하는 총괄 책임자입니다. 가격 데이터를 받아 기회를 포착하고, 사이클의 상태에 따라 적절한 서비스(`Processor`)를 호출합니다.
  - `ArbitrageCycleStateService`: `IDLE`, `PROCESSING` 등 현재 시스템의 상태를 중앙에서 관리하는 상태 머신(State Machine)입니다. 이를 통해 한 번에 하나의 차익거래 사이클만 실행되도록 보장합니다.
  - `HighPremiumProcessorService`: '고프리미엄' 차익거래 단계의 실행을 전담합니다.
  - `LowPremiumProcessorService`: '저프리미엄' 차익거래 단계의 실행을 전담합니다.
  - `CycleCompletionService`: 성공, 실패 등 모든 사이클 종료 후의 후처리(포트폴리오 기록, 알림 전송)를 담당합니다.

### **3. 거래 실행 및 연동 계층 (`CommonModule`, `UpbitModule`, `BinanceModule`)**

- **역할**: 실제 거래소 API와의 통신을 담당합니다. 실제 거래와 시뮬레이션을 유연하게 전환할 수 있도록 추상화되어 있습니다.
- **주요 서비스**:
  - `ExchangeService`: 주문, 잔고 조회, 출금 등 모든 거래소 관련 요청을 중개하는 단일 창구(Facade)입니다. `UpbitService`나 `BinanceService`를 직접 호출하는 대신 이 서비스를 사용합니다.
  - `UpbitService` / `BinanceService`: 각 거래소의 API 명세에 맞춰 실제 통신을 담당합니다. 거래소별 티커(`BTT` vs `BTTC`)나 네트워크 타입(`TRX`)의 차이를 내부적으로 처리합니다.
  - `SimulationExchangeService`: 실제 API 호출 없이 메모리상에서 거래를 흉내 내는 가상 서비스로, `.env` 파일의 설정에 따라 `UpbitService`나 `BinanceService` 대신 주입될 수 있습니다.

### **4. 데이터 영속성 계층 (`DbModule`)**

- **역할**: 모든 차익거래 사이클의 결과와 자산 변동 내역을 데이터베이스에 영구적으로 기록합니다.
- **주요 서비스 및 엔티티**:
  - `ArbitrageRecordService`: `ArbitrageCycle` 엔티티의 생성 및 수정을 담당합니다.
  - `PortfolioLogService`: `PortfolioLog` 엔티티의 생성 및 조회를 담당하며, 이전 거래의 손익을 다음 투자금에 반영하는 기반 데이터를 제공합니다.
  - `ArbitrageCycle` / `PortfolioLog`: TypeORM을 통해 실제 DB 테이블과 매핑되는 엔티티 클래스입니다.

### **5. 알림 및 유틸리티 계층 (`NotificationModule`, `CommonModule`)**

- **역할**: 사용자에게 중요한 정보를 전달하고, 시스템 전반에서 사용되는 공통 기능을 제공합니다.
- **주요 서비스**:
  - `NotificationComposerService`: 사이클 결과를 바탕으로 텔레그램 메시지 내용을 구성합니다.
  - `TelegramService`: 구성된 메시지를 실제 텔레그램 봇을 통해 발송합니다.
  - `FeeCalculatorService`: 거래/전송 수수료를 계산하여 예상 순수익률을 산출합니다.

## 데이터 흐름 (주요 흐름)

1.  **가격 수신 및 기회 판단**: `PriceFeedService` -> `WsService` -> `ArbitrageFlowManagerService`에서 고프리미엄 기회 판단.
2.  **고프리미엄 단계 실행**: `ArbitrageFlowManagerService` -> `HighPremiumProcessorService`에서 자본금 확인, 사이클 생성, 거래 시뮬레이션, 상태 변경.
3.  **저프리미엄 단계 실행 (고프 성공 시)**: `ArbitrageFlowManagerService` -> `LowPremiumProcessorService`에서 기회 탐색, 거래 시뮬레이션, 사이클 완료 처리.
4.  **사이클 완료 처리 (모든 종료 상황)**: `ArbitrageFlowManagerService` -> `CycleCompletionService`에서 최종 데이터 조회, 포트폴리오 로그 업데이트, 알림 전송, 상태 리셋.

## 실행 방법

```bash
# 의존성 설치
npm install

# .env 파일 생성 및 API 키 등 환경 변수 설정
# .env.example 파일 참고

# 개발 모드로 실행 (핫 리로딩)
npm run start:dev

# 프로덕션 빌드
npm run build

# 프로덕션 모드로 실행
npm run start:prod
```

## 테스트 코드 (API 엔드포인트)

개발 및 디버깅을 위해 `src/app.controller.ts`에 다양한 테스트용 API 엔드포인트가 구현되어 있습니다.

### **메인 테스트: 전체 플로우 실행**

역프리미엄 상황을 가정한 전체 차익거래 사이클을 테스트합니다.
(업비트 매수 → 바이낸스 전송 → 바이낸스 매도 → 바이낸스 재매수 → 업비트 전송 → 업비트 매도)

- **URL**: `GET /test-full-flow`
- **쿼리 파라미터**:
  - `coin` (선택, 기본값: `XRP`): 테스트에 사용할 코인 심볼.
  - `amountKRW` (선택, 기본값: `20000`): 초기 투자 원화 금액.
- **예시**:
  ```
  http://localhost:3000/test-full-flow?coin=BTT&amountKRW=30000
  ```

### **단일 기능 테스트**

- **잔고 조회**:

  - `GET /test-upbit-balance`
  - `GET /test-binance-balance`

- **네트워크 타입 조회 (업비트)**: 특정 코인이 업비트에서 지원하는 네트워크(`net_type`) 목록을 확인합니다.

  - **URL**: `GET /test-get-network-type/:symbol`
  - **예시**: `http://localhost:3000/test-get-network-type/btt`

- **입금 주소 조회**:

  - **URL**: `GET /test-deposit-address/:symbol`
  - **예시**: `http://localhost:3000/test-deposit-address/xrp`

- **지갑 상태 조회**:

  - **URL**: `GET /test-wallet-status/:symbol`
  - **예시**: `http://localhost:3000/test-wallet-status/trx`

- **주문 생성 테스트**:

  - `GET /test-upbit-order`
  - `GET /test-binance-order`
  - `GET /test-buy-by-value?exchange=<upbit|binance>&symbol=<SYMBOL>&amount=<AMOUNT>&unit=<KRW|USDT>`

- **전량 매도 테스트**:

  - **URL**: `GET /test-upbit-sell-all/:symbol`
  - **URL**: `GET /test-binance-sell-all/:symbol`

- **출금 테스트 (주의: 실제 자금이 이동됩니다)**:
  - `GET /test-upbit-withdraw` (컨트롤러 코드 내에 목적지 주소 하드코딩 필요)
  - `GET /test-binance-withdraw` (컨트롤러 코드 내에 목적지 주소 하드코딩 필요)
