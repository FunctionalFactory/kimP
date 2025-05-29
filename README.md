1. 프로젝트 개요
   kimP는 여러 암호화폐 거래소(현재 업비트 및 바이낸스) 간의 가격 차이(일명 '김치 프리미엄' 또는 '역프리미엄')를 이용한 차익거래 기회를 포착하고, 이를 관리 및 알림을 제공하는 시스템입니다. 본 프로젝트는 시뮬레이션 기반의 차익거래 로직을 포함하며, 실제 자금으로 거래하는 기능은 포함되어 있지 않거나 별도의 주의가 필요합니다.

주요 기능은 다음과 같습니다:

- 여러 거래소의 특정 암호화폐 페어 가격 정보 실시간 수집.
- 수집된 가격을 바탕으로 차익거래 기회(스프레드) 계산.
- 미리 정의된 조건 충족 시 차익거래 사이클 시작 (시뮬레이션).
- 차익거래 사이클은 고프리미엄 단계와 저프리미엄 단계로 구성될 수 있음.
- 각 사이클의 진행 상황 및 결과를 데이터베이스에 기록.
- 이전 거래의 손익을 반영하여 다음 거래의 투자 자본금을 동적으로 조절.
- 사이클 완료 또는 주요 이벤트 발생 시 텔레그램으로 알림 전송.

2. 기술 스택

- 프레임워크: NestJS (Node.js)
- 언어: TypeScript
- 데이터베이스: PostgreSQL (TypeORM 사용)
- 실시간 데이터 수집: WebSocket

주요 라이브러리:

- rxjs: 반응형 프로그래밍 (이벤트 처리 등)
- nestjs-telegraf: Telegram 봇 연동
- ccxt (ExchangeService 내부): 다양한 거래소 API 연동 (현재 직접적인 사용보다는 WebSocket 기반)
- ConfigModule: 환경 변수 관리
- ScheduleModule: 주기적인 작업 스케줄링 (현재는 WebSocket 이벤트 기반으로 주로 동작)

3. 디렉토리 구조 및 주요 기능

루트 디렉토리 (src/)

- main.ts: 애플리케이션의 주요 진입점. NestJS 애플리케이션을 생성하고 시작합니다. 전역 파이프(예: ValidationPipe) 등을 설정합니다.
- app.module.ts: 프로젝트의 루트 모듈. 주요 기능 모듈들을 통합하고, 전역 설정(ConfigModule, TypeOrmModule, ScheduleModule, TelegrafModule 등)을 담당합니다.
- app.controller.ts / app.service.ts: 기본적인 상태 확인용 엔드포인트 및 서비스 로직 (주로 NestJS 프로젝트 생성 시 기본 제공).

src/ws/ - 웹소켓 및 이벤트 처리 초기 진입점

- ws.module.ts: WsService를 정의하고 필요한 모듈(MarketDataModule, ArbitrageModule)을 임포트합니다.
- ws.service.ts:
  - 역할: 과거에는 많은 로직을 포함했으나, 리팩토링 후에는 주로 애플리케이션 초기화 시 PriceFeedService의 가격 업데이트 스트림을 구독하고, 수신된 가격 정보를 ArbitrageFlowManagerService로 전달하는 역할로 축소되었습니다.
  - 주요 기능:
    - PriceFeedService의 priceUpdate$ Observable 구독.
    - 가격 데이터 수신 시 ArbitrageFlowManagerService.handlePriceUpdate() 호출.
    - 애플리케이션 생명주기(OnModuleInit, OnModuleDestroy)에 따른 구독 관리.

src/marketdata/ - 시장 데이터 수집 및 제공

- marketdata.module.ts: PriceFeedService를 정의하고 내보냅니다. ConfigModule을 임포트합니다.
- price-feed.service.ts:
  - 역할: 여러 거래소(업비트, 바이낸스)로부터 실시간 가격 데이터를 수집하고, 이를 필요로 하는 다른 서비스에 제공(이벤트 발행)합니다.
  - 주요 기능:
    - watchedSymbolsConfig에 정의된 암호화폐 페어에 대해 각 거래소의 WebSocket에 연결 및 관리.
    - 수신된 실시간 티커 정보를 내부적으로 upbitPrices, binancePrices 맵에 저장.
    - 가격 업데이트 시 priceUpdate$ Observable (Subject)을 통해 PriceUpdateData (심볼, 거래소, 가격 정보 포함) 이벤트를 발행.
    - 웹소켓 재연결 로직 및 연결 해제 처리.
    - 외부에서 현재 가격 및 감시 중인 심볼 목록을 조회할 수 있는 getter 메소드 제공.
    - 인터페이스/DTO: PriceUpdateData, WatchedSymbolConfig 등.

src/arbitrage/ - 차익거래 핵심 로직 및 상태 관리
이 모듈은 실제 차익거래 로직의 실행 흐름, 상태 관리, 단계별 처리 등을 담당하는 서비스들을 포함합니다.

- arbitrage.module.ts: 차익거래 관련 모든 서비스(ArbitrageFlowManagerService, ArbitrageCycleStateService, HighPremiumProcessorService, LowPremiumProcessorService, CycleCompletionService)를 정의하고 필요한 모듈(MarketDataModule, NotificationModule, TypeOrmModule, 공통 서비스 등)을 임포트합니다.
- arbitrage-cycle-state.service.ts:

  - 역할: 차익거래 사이클의 현재 상태(CycleExecutionStatus)와 관련된 모든 변수(활성 사이클 ID, 필요 수익, 포트폴리오 로그 등)를 중앙에서 관리합니다.
  - 주요 기능:
    - 사이클 상태 변수 (private) 및 이에 대한 public getter 제공.
    - 상태 전이를 위한 메소드 제공 (예: startHighPremiumProcessing, completeHighPremiumAndAwaitLowPremium, startLowPremiumProcessing, resetCycleState).
    - 상태 정보의 일관성 유지.

- arbitrage-flow-manager.service.ts (또는 CycleOrchestratorService):

  - 역할: 전체 차익거래 흐름의 최상위 오케스트레이터. 각 단계별 전문 서비스들을 호출하고, 그 결과를 바탕으로 다음 단계를 결정합니다.
  - 주요 기능:
    - PriceFeedService로부터 가격 업데이트를 받아(handlePriceUpdate) 차익거래 기회 판단 시작.
    - ArbitrageCycleStateService를 통해 현재 시스템 상태 확인.
    - IDLE 상태: SpreadCalculatorService 호출 -> 조건 충족 시 HighPremiumProcessorService 호출.
    - AWAITING_LOW_PREMIUM 상태: LowPremiumProcessorService 호출.
    - 각 Processor 서비스의 처리 결과에 따라 CycleCompletionService 호출.

- high-premium-processor.service.ts:

  - 역할: 고프리미엄 차익거래 단계의 실행 로직을 전담합니다.
  - 주요 기능:
    - 초기 자본금 조회 (PortfolioLogService 사용).
    - 사이클 정보 생성 및 DB 기록 (ArbitrageRecordService 사용).
    - ArbitrageCycleStateService를 통해 상태 변경.
    - 고프리미엄 거래 시뮬레이션 실행 (ArbitrageService 또는 StrategyHighService 사용).
    - 저프리미엄 단계 필요 수익 계산.
    - 성공/실패 결과 반환.

- low-premium-processor.service.ts:

  - 역할: 저프리미엄 차익거래 단계의 실행 로직을 전담합니다.
  - 주요 기능:
    - ArbitrageCycleStateService에서 현재 사이클 정보(투자금, 필요 수익 등) 가져오기.
    - 타임아웃 관리.
    - 최적의 저프리미엄 기회 탐색 (PriceFeedService, FeeCalculatorService 사용).
    - ArbitrageCycleStateService를 통해 상태 변경.
    - 저프리미엄 거래 시뮬레이션 실행 (StrategyLowService 사용).
    - 성공/실패/타임아웃 결과 반환.

- cycle-completion.service.ts:
  - 역할: 차익거래 사이클의 모든 종류의 종료(성공, 실패, 타임아웃 등) 후 공통적으로 수행해야 할 후처리 작업을 담당합니다.
  - 주요 기능:
    - ArbitrageRecordService에서 최종 사이클 데이터 조회.
    - 이전 포트폴리오 정보와 현재 사이클 PNL을 바탕으로 새로운 포트폴리오 로그 생성 및 기록 (PortfolioLogService 사용 - finalizeCycleAndLogPortfolio 로직).
    - 텔레그램 알림 및 상세 콘솔 로그 생성/전송 (NotificationComposerService 사용).
    - 모든 후처리 완료 후 ArbitrageCycleStateService.resetCycleState() 호출.

src/notification/ - 알림 관련 기능

- notification.module.ts: NotificationComposerService와 TelegramService를 정의하고 필요한 모듈을 임포트합니다.
- notification-composer.service.ts:
  - 역할: 다양한 상황(사이클 완료, 실패 등)에 맞는 텔레그램 메시지 및 상세 콘솔 로그의 내용을 구성(formatting)합니다.
  - 주요 기능:
    - ArbitrageCycle 데이터와 최신 PortfolioLog 데이터를 받아 사용자 친화적인 메시지 생성.
    - 실제 메시지 전송은 TelegramService에 위임.
    - 상세 정보 로깅은 내부 Logger 사용.
    - (참고) TelegramService는 src/common/telegram.service.ts에 위치할 수도 있으며, 이 경우 NotificationModule은 해당 서비스를 common으로부터 가져와 사용합니다. 현재 구조에서는 NotificationModule이 TelegramService를 providers로 가지고 exports 하는 것이 자연스럽습니다.

src/db/ - 데이터베이스 관련 서비스 및 엔티티

- entities/:
  - arbitrage-cycle.entity.ts: 차익거래 사이클 정보를 나타내는 TypeORM 엔티티. 각 사이클의 단계별 정보, 투자금, 손익, 상태 등을 기록합니다.
  - portfolio-log.entity.ts: 포트폴리오 변경 이력을 나타내는 TypeORM 엔티티. 각 사이클 완료 후 또는 주요 자산 변동 시 총 자산, 개별 거래소 잔고(KRW 환산), 직전 사이클 손익 등을 기록합니다.
- arbitrage-record.service.ts: ArbitrageCycle 엔티티에 대한 CRUD 작업을 담당합니다.
- portfolio-log.service.ts: PortfolioLog 엔티티에 대한 CRUD 작업을 담당합니다. (만약 PortfolioUpdateService가 별도로 생성되었다면, 이 서비스의 책임이 일부 이동될 수 있습니다.)

src/common/ - 공용 서비스 및 유틸리티

- 애플리케이션 전반에서 사용되는 다양한 유틸리티성 서비스들을 포함합니다.

- exchange.service.ts: 거래소 API 연동(주로 REST API, 예: 잔고 조회, USDT-KRW 환율 조회 등)을 담당합니다. ccxt 라이브러리 사용 가능성이 언급되었으나, 현재는 CoinGecko를 통한 환율 조회 등이 주된 기능일 수 있습니다.
- fee-calculator.service.ts: 거래소별, 코인별 거래 수수료(Taker/Maker, 출금 수수료 등)를 계산합니다.
- spread-calculator.service.ts: 두 거래소 간의 특정 코인 가격 차이(스프레드) 및 김치 프리미엄 비율을 계산하고, 차익거래 조건 만족 여부를 판단하여 콜백을 실행합니다.
- profit-calculator.service.ts: 수수료 등을 고려한 순수익률을 계산합니다. (현재 FeeCalculatorService에서 통합적으로 처리될 수도 있음)
- cycle-profit-calculator.service.ts: 전체 차익거래 사이클에 대한 최종 수익을 계산합니다. (현재 각 Processor 서비스 또는 ArbitrageCycle 엔티티 내에서 관리될 수 있음)
- strategy-high.service.ts: 고프리미엄 상황에서의 특정 거래 전략(매수/매도/송금 시뮬레이션 및 DB 업데이트)을 실행합니다.
- strategy-low.service.ts: 저프리미엄 상황에서의 특정 거래 전략(매수/매도/송금 시뮬레이션 및 DB 업데이트)을 실행합니다.
- arbitrage.service.ts: StrategyHighService 등을 호출하여 실제 거래 시뮬레이션 흐름을 관장합니다. (주로 고프리미엄 단계에서 사용)
- arbitrage-detector.service.ts: (현재 리팩토링된 구조에서는 SpreadCalculatorService와 ArbitrageFlowManagerService가 이 역할을 분담하고 있을 가능성이 높음) 과거에는 주기적으로 차익거래 기회를 탐지하고 알림을 보내는 역할을 했을 수 있습니다.
- telegram.service.ts: nestjs-telegraf를 사용하여 실제 Telegram 메시지 전송 기능을 담당합니다. NotificationComposerService로부터 메시지 내용을 받아 전송합니다.

4. 데이터 흐름 (리팩토링 후 예상)

- PriceFeedService: 업비트/바이낸스 웹소켓에서 실시간 가격 수신 -> priceUpdate$ 이벤트 발행.
- WsService: priceUpdate$ 구독 -> ArbitrageFlowManagerService.handlePriceUpdate(symbol) 호출.
- ArbitrageFlowManagerService.handlePriceUpdate():
  - IDLE 상태 시: PriceFeedService에서 양쪽 가격 조회 -> SpreadCalculatorService.calculateSpread() 호출.
  - 조건 만족 시 (onArbitrageConditionMet 콜백): HighPremiumProcessorService.processHighPremiumOpportunity() 호출.
  - AWAITING_LOW_PREMIUM 상태 시: LowPremiumProcessorService.processLowPremiumOpportunity() 호출.
  - HighPremiumProcessorService.processHighPremiumOpportunity():
    - 자본금 조회 (PortfolioLogService) -> 사이클 생성/DB 기록 (ArbitrageRecordService) -> 상태 변경 (ArbitrageCycleStateService) -> 고프 거래 시뮬레이션 (ArbitrageService -> StrategyHighService) -> DB 업데이트 -> 저프 필요수익 계산 -> 상태 변경 (ArbitrageCycleStateService) -> 결과 반환 (성공 시 nextStep: 'awaitLowPremium').
    - 실패 시: 결과 반환 (nextStep: 'failed').
  - ArbitrageFlowManagerService (HighPremiumProcessor 결과 처리):
    - 성공 및 awaitLowPremium: LowPremiumProcessorService.processLowPremiumOpportunity() 호출.
    - 실패: CycleCompletionService.completeCycle() 호출.
  - LowPremiumProcessorService.processLowPremiumOpportunity():
    - 상태/조건 확인 (ArbitrageCycleStateService) -> 투자금 조회 (ArbitrageRecordService) -> 타임아웃 체크 -> 저프 기회 탐색 (PriceFeedService, FeeCalculatorService) -> 상태 변경 (ArbitrageCycleStateService) -> 저프 거래 시뮬레이션 (StrategyLowService) -> DB 업데이트 -> 성공/실패/타임아웃 결과 반환.
  - ArbitrageFlowManagerService (LowPremiumProcessor 결과 처리):
    - 결과 수신 시 (기회 없음 null 제외) CycleCompletionService.completeCycle() 호출.
  - CycleCompletionService.completeCycle():
    - 최종 사이클 데이터 조회 (ArbitrageRecordService) -> 포트폴리오 로그 기록 (finalizeCycleAndLogPortfolio 내부에서 PortfolioLogService 사용) -> 알림/로그 생성 및 전송 (NotificationComposerService 사용) -> 사이클 상태 리셋 (ArbitrageCycleStateService.resetCycleState()).

5. 실행 방법
   (표준 NestJS 프로젝트 실행 방법)

Bash

```bash
# 의존성 설치

npm install
```

```bash
# 개발 모드로 실행 (핫 리로딩)

npm run start:dev
```

```bash
# 프로덕션 빌드

npm run build
```

```bash
# 프로덕션 모드로 실행

npm run start:prod
```

6. 환경 변수

.env 파일에 다음과 같은 환경 변수 설정이 필요합니다:

- DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
- TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
- INITIAL_CAPITAL_KRW (초기 자본금)
- PROFIT_THRESHOLD_PERCENT (차익거래 진입 기준 수익률)
- TARGET_OVERALL_CYCLE_PROFIT_PERCENT (전체 사이클 목표 수익률)
- LOW_PREMIUM_SEARCH_TIMEOUT_MS (저프리미엄 탐색 타임아웃)
- (필요시) 거래소 API 키 (현재는 WebSocket 위주이므로 필수 아닐 수 있음)
