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
- **데이터베이스**: PostgreSQL (TypeORM 사용)
- **실시간 데이터 수집**: WebSocket
- **주요 라이브러리**:
  - `rxjs`: 반응형 프로그래밍 (이벤트 스트림 처리)
  - `nestjs-telegraf`: Telegram 봇 연동
  - `@nestjs/config`: 환경 변수 및 설정 관리
  - `@nestjs/schedule`: (현재는 WebSocket 이벤트 기반으로 주로 동작하나, 보조적 역할로 사용될 수 있음)

## 아키텍처 및 주요 모듈 (리팩토링 후)

kimP 시스템은 기능별 책임 분리를 위해 모듈화된 아키텍처를 따릅니다. 주요 모듈 및 서비스는 다음과 같습니다:

- **`MarketDataModule` (`price-feed.service.ts`)**:

  - 여러 거래소(업비트, 바이낸스)로부터 WebSocket을 통해 실시간 가격 데이터를 수집하고, 이를 `priceUpdate$` Observable 스트림으로 발행합니다.
  - 모니터링 대상 코인 목록 및 현재 수신된 가격 정보를 관리합니다.

- **`WsModule` (`ws.service.ts`)**:

  - 애플리케이션 초기화 시 `PriceFeedService`의 가격 업데이트 스트림을 구독합니다.
  - 수신된 가격 정보를 `ArbitrageFlowManagerService`로 전달하여 차익거래 로직 실행을 트리거합니다. (이벤트 기반 진입점 역할)

- **`ArbitrageModule`**: 차익거래의 핵심 로직과 상태 관리, 단계별 처리를 담당하는 서비스들을 포함합니다.

  - **`ArbitrageCycleStateService`**:
    - 현재 진행 중인 차익거래 사이클의 상태(`IDLE`, `HIGH_PREMIUM_PROCESSING`, `AWAITING_LOW_PREMIUM`, `LOW_PREMIUM_PROCESSING`)와 관련 데이터(활성 사이클 ID, 단계별 필요 수익, 시작 시점 포트폴리오 정보 등)를 중앙에서 관리합니다.
  - **`ArbitrageFlowManagerService` (Cycle Orchestrator)**:
    - 전체 차익거래 흐름을 총괄 지휘합니다.
    - `PriceFeedService`로부터 가격 업데이트를 받아 현재 사이클 상태에 따라 적절한 `ProcessorService`를 호출합니다.
    - 각 `ProcessorService`의 결과를 받아 다음 단계를 결정하고, 최종적으로 `CycleCompletionService`를 호출합니다.
  - **`HighPremiumProcessorService`**:
    - 고프리미엄 차익거래 단계의 실행을 전담합니다.
    - 초기 자본금 확인 (`PortfolioLogService`), 사이클 생성 (`ArbitrageRecordService`), `ArbitrageService`를 통한 초기 거래 실행(시뮬레이션 및 **예상 손익** DB 기록), 송금 시간 시뮬레이션, 그리고 저프리미엄 단계 전환을 위한 상태 및 필요 수익 계산을 수행합니다.
  - **`LowPremiumProcessorService`**:
    - 저프리미엄 차익거래 단계의 실행을 전담합니다.
    - `ArbitrageCycleStateService`로부터 현재 사이클 정보(투자금, 필요 수익, 탐색 시작 시간)를 가져옵니다.
    - 경과 시간에 따라 목표 수익률을 점진적으로 하향 조정하며, 최대 탐색 기간("소프트 타임아웃")을 관리합니다.
    - `PriceFeedService`, `FeeCalculatorService`, `ExchangeService`를 사용하여 최적의 저프리미엄 기회를 탐색합니다.
    - 조건 충족 시 `StrategyLowService`를 통한 거래 시뮬레이션(송금 시간 포함 및 **예상 손익** DB 기록)을 수행하고 사이클을 완료합니다.
  - **`CycleCompletionService`**:
    - 차익거래 사이클의 모든 종류의 종료(성공, 실패, 타임아웃 등) 후 공통 후처리 작업을 담당합니다.
    - `ArbitrageRecordService`에서 최종 사이클 데이터를 조회합니다.
    - `PortfolioLogService`를 호출하여 이전 포트폴리오 정보와 현재 사이클의 PNL을 바탕으로 새로운 포트폴리오 로그를 기록합니다.
    - `NotificationComposerService`를 호출하여 텔레그램 알림 및 상세 콘솔 로그를 생성/전송합니다.
    - 모든 후처리 완료 후 `ArbitrageCycleStateService`를 통해 사이클 상태를 `IDLE`로 리셋합니다.

- **`NotificationModule`**:

  - **`NotificationComposerService`**: 사이클 결과 및 포트폴리오 정보를 바탕으로 사용자에게 전달될 텔레그램 메시지와 상세 콘솔 로그의 내용을 구성합니다.
  - **`TelegramService` (common에 위치)**: 실제 텔레그램 메시지 발송을 담당합니다.

- **`DbModule` (또는 `TypeOrmModule` 설정)**: 데이터베이스 연동 및 엔티티 관리를 담당합니다.

  - **Entities**: `ArbitrageCycle`, `PortfolioLog`.
  - **Services**: `ArbitrageRecordService`, `PortfolioLogService`.

- **`CommonModule` (또는 개별 Common 서비스들)**: 애플리케이션 전반에서 사용되는 공통 유틸리티 서비스들을 포함합니다.
  - **`ExchangeService`**: 외부 거래소 정보 조회 (예: USDT/KRW 환율 - CoinGecko API 사용).
  - **`FeeCalculatorService`**: 거래 및 전송과 관련된 모든 수수료를 계산하여 **예상 순수익 및 순수익률** 산출을 지원합니다. (선물 관련 수수료는 현재 전략에서 제외됨).
  - **`SpreadCalculatorService`**: 초기 차익거래 기회(스프레드 및 예상 순수익률)를 계산하고 조건 충족 시 콜백을 실행합니다.
  - **`ArbitrageService`**: 주로 고프리미엄 단계의 "초기 거래 실행" 시뮬레이션(예: 바이낸스 매수) 및 관련 **예상** 정보를 DB에 기록하는 역할을 담당합니다.
  - **`StrategyHighService` / `StrategyLowService`**: 각 프리미엄 단계에서의 구체적인 거래 실행(시뮬레이션) 및 해당 단계의 **예상** 손익을 DB에 최종 업데이트하는 로직을 수행합니다.

## 데이터 흐름 (주요 흐름)

1.  **가격 수신 및 초기 기회 판단**:
    - `PriceFeedService` -> `WsService` -> `ArbitrageFlowManagerService.handlePriceUpdate()`.
    - `IDLE` 상태 시: `SpreadCalculatorService`가 고프리미엄 기회 판단.
2.  **고프리미엄 단계 실행**:
    - `ArbitrageFlowManagerService` -> `HighPremiumProcessorService.processHighPremiumOpportunity()`.
    - 내부적으로 자본금 확인 (`PortfolioLogService`), 사이클 생성 (`ArbitrageRecordService`), 초기 거래 시뮬레이션 (`ArbitrageService` -> `StrategyHighService`가 **예상 손익** DB 업데이트), 송금 시뮬레이션, 상태 변경 (`ArbitrageCycleStateService`).
3.  **저프리미엄 단계 실행 (고프 성공 시)**:
    - `ArbitrageFlowManagerService` (또는 `handlePriceUpdate` 재진입) -> `LowPremiumProcessorService.processLowPremiumOpportunity()`.
    - 내부적으로 투자금/필요수익 확인, 타임아웃 및 목표수익률 조정 관리, 기회 탐색 (`PriceFeedService`, `FeeCalculatorService`), 거래 시뮬레이션 (`StrategyLowService`가 **예상 손익** DB 업데이트 및 사이클 완료 처리), 송금 시뮬레이션.
4.  **사이클 완료 처리 (모든 종료 상황)**:
    - 각 `ProcessorService`의 결과에 따라 `ArbitrageFlowManagerService` -> `CycleCompletionService.completeCycle()`.
    - 내부적으로 최종 사이클 데이터 조회 (`ArbitrageRecordService`), 포트폴리오 로그 업데이트 (`PortfolioLogService`), 알림/로그 생성 및 전송 (`NotificationComposerService`), 상태 리셋 (`ArbitrageCycleStateService`).

## 실행 방법

```bash
# 의존성 설치
npm install

# 개발 모드로 실행 (핫 리로딩)
npm run start:dev

# 프로덕션 빌드
npm run build

# 프로덕션 모드로 실행
npm run start:prod
```
