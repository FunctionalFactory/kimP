# kimP (김치 프리미엄 차익거래 보조 시스템)

서로 다른 암호화폐 거래소 간의 가격 차이(김치 프리미엄 또는 역프리미엄)를 이용한 차익거래 기회를 포착하고, 이를 관리하며 알림을 제공하는 시스템입니다. 본 프로젝트는 실제 거래를 위한 기반을 갖추고 있으며, 시뮬레이션 모드를 통해 안정적인 테스트를 지원합니다.

## 주요 기능

- **실시간 데이터 수집:** 여러 거래소(현재 업비트 및 바이낸스)의 특정 암호화폐 페어 가격 정보를 WebSocket을 통해 실시간으로 수집합니다.
- **다단계 필터링을 통한 정교한 기회 선별:** 단순 가격 비교를 넘어, **'시세 → 24시간 거래대금 → 실시간 호가창(슬리피지)'** 순서로 기회를 3단계에 걸쳐 검증하여 거래의 안정성을 극대화합니다.
- **정밀 슬리피지 예측:** 실제 호가창 데이터를 분석하여 지정된 투자 금액에 대한 예상 체결 가격과 슬리피지를 정밀하게 계산합니다. 이를 통해 수익성 판단의 정확도를 높입니다.
- **지정가 주문 기반의 능동적 거래 실행:** 미체결 리스크를 관리하기 위해, 지정가 주문이 일정 시간 체결되지 않을 경우 설정된 규칙에 따라 **가격을 자동으로 정정하며 재주문(호가 추적)**하는 로직을 적용합니다.
- **동적 자본 관리:** 이전 차익거래 사이클의 순손익을 다음 거래의 투자 자본금에 자동으로 반영하여, 복리 효과를 기대할 수 있습니다.
- **유연한 자금 회수 전략:** 고프리미엄(HP) 단계에서 사용한 코인과 자금 회수(LP) 단계에서 사용할 코인을 다르게 선택할 수 있어, 가장 효율적인 경로로 사이클을 완료할 수 있습니다.
- **상세 정보 기록 및 알림:** 각 사이클의 진행 상황, 손익, 수수료, 슬리피지 등 모든 상세 정보를 데이터베이스에 기록하며, 사이클 완료 또는 오류 발생 시 텔레그램으로 즉시 알림을 전송합니다.
- **세션 기반 병렬 처리 시스템:** 여러 차익거래 기회를 동시에 처리할 수 있는 세션 관리 시스템으로, 시스템 리소스를 효율적으로 활용하며 동시성을 극대화합니다.
- **자동 자금 검증 시스템:** 각 세션 시작 전 자동으로 거래소 잔고를 검증하여, 자금 부족으로 인한 거래 실패를 사전에 방지합니다.
- **입금 모니터링 시스템:** 출금 후 입금 확인을 자동으로 모니터링하여, 거래 사이클의 완전성을 보장합니다.
- **출금 제약 조건 관리:** 각 코인별 출금 최소량, 정밀도 등의 제약 조건을 자동으로 적용하여 출금 실패를 방지합니다.
- **시뮬레이션 모드 지원:** 실제 거래 없이 시스템을 테스트할 수 있는 완전한 시뮬레이션 환경을 제공합니다.

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

kimP 시스템은 기능별 책임 분리를 위해 모듈화된 아키텍처를 따릅니다.

### **1. 데이터 수집 계층 (`MarketDataModule`, `WsModule`)**

- **역할**: 모든 차익거래 판단의 기초가 되는 실시간 시장 데이터를 수집하고 전파합니다.
- **주요 서비스**:
  - `PriceFeedService`: 업비트, 바이낸스와의 WebSocket 연결을 유지하며, 실시간 시세 데이터를 수신하여 RxJS `Subject`를 통해 시스템 내부에 방송합니다.
  - `WsService`: `PriceFeedService`가 방송하는 가격 데이터를 구독하여, 차익거래 로직의 총괄 책임자인 `ArbitrageFlowManagerService`에게 전달하는 진입점(Entrypoint) 역할을 합니다.

### **2. 핵심 로직 계층 (`ArbitrageModule`)**

- **역할**: 차익거래 기회를 판단하고, 전체 사이클의 흐름을 관리하며, 단계별 로직을 실행하는 시스템의 심장부입니다.
- **주요 서비스**:
  - `ArbitrageFlowManagerService`: 전체 흐름을 지휘하는 총괄 책임자입니다. 다단계 필터링을 통해 기회를 검증하고, 사이클 상태에 따라 적절한 서비스(`Processor`)를 호출합니다.
  - `ArbitrageCycleStateService`: `IDLE`, `AWAITING_LOW_PREMIUM` 등 시스템의 상태를 중앙에서 관리하는 상태 머신입니다.
  - `HighPremiumProcessorService` / `LowPremiumProcessorService`: 각각 '고프리미엄'과 '저프리미엄' 단계의 기회 검증 및 거래 실행 요청을 전담합니다.
  - `CycleCompletionService`: 모든 사이클 종료 후의 후처리(포트폴리오 기록, 알림 전송)를 담당합니다.
  - `DepositMonitorService`: 출금 후 입금 확인을 자동으로 모니터링하여 거래 사이클의 완전성을 보장합니다.

### **3. 세션 관리 계층 (`SessionModule`)**

- **역할**: 여러 차익거래 기회를 동시에 처리할 수 있는 세션 기반 병렬 처리 시스템을 관리합니다.
- **주요 서비스**:
  - `SessionManagerService`: 세션의 생성, 관리, 상태 추적을 담당하며, 실시간 기회 탐색과 주기적 스캔을 통해 새로운 세션을 생성합니다.
  - `SessionExecutorService`: 각 세션의 실행을 담당하며, 세션 상태에 따라 적절한 처리 로직을 실행합니다.
  - `SessionStateService`: 세션의 상태 정보를 메모리에서 관리하며, 세션 생성, 상태 변경, 조회 기능을 제공합니다.
  - `SessionPriorityService`: 여러 세션 간의 우선순위를 계산하여 효율적인 처리 순서를 결정합니다.
  - `SessionFundValidationService`: 세션 시작 전 자동으로 거래소 잔고를 검증하여 자금 부족으로 인한 거래 실패를 사전에 방지합니다.

### **4. 거래 실행 및 연동 계층 (`CommonModule`, `UpbitModule`, `BinanceModule`)**

- **역할**: 실제 거래소 API와의 통신을 담당합니다. `IExchange` 인터페이스를 통해 실제 거래와 시뮬레이션을 유연하게 전환할 수 있도록 추상화되어 있습니다.
- **주요 서비스**:
  - `ExchangeService`: 주문 생성/조회/취소, 잔고 조회, 출금, 호가창 조회 등 모든 거래소 관련 요청을 중개하는 단일 창구(Facade)입니다.
  - `UpbitService` / `BinanceService`: 각 거래소의 API 명세에 맞춰 실제 통신을 담당하며, 이제 주문 취소 및 호가창 조회 기능까지 완벽히 구현되었습니다.
  - `StrategyHighService` / `StrategyLowService`: '호가 추적' 로직을 포함하여, 미체결 주문에 능동적으로 대응하며 안전하게 거래를 실행합니다.
  - `SimulationExchangeService`: 실제 API 호출 없이 메모리상에서 거래를 흉내 내는 가상 서비스입니다.
  - `WithdrawalConstraintService`: 각 코인별 출금 최소량, 정밀도 등의 제약 조건을 자동으로 적용하여 출금 실패를 방지합니다.

### **5. 데이터 영속성 계층 (DB 관련 모듈)**

- **역할**: 모든 차익거래 사이클의 결과와 자산 변동 내역을 데이터베이스에 영구적으로 기록합니다.
- **주요 서비스 및 엔티티**:
  - `ArbitrageRecordService`: `ArbitrageCycle` 엔티티의 생성 및 수정을 담당합니다.
  - `PortfolioLogService`: `PortfolioLog` 엔티티의 생성 및 조회를 담당하며, 동적 자본 관리에 필요한 기반 데이터를 제공합니다.
  - `SessionFundValidationService`: 세션 자금 검증 결과를 `SessionFundValidation` 엔티티에 기록하여 검증 이력을 관리합니다.
  - `ArbitrageCycle` / `PortfolioLog` / `SessionFundValidation`: TypeORM을 통해 실제 DB 테이블과 매핑되는 엔티티 클래스입니다.

### **6. 알림 및 유틸리티 계층 (`NotificationModule`, `CommonModule`)**

- **역할**: 사용자에게 중요한 정보를 전달하고, 시스템 전반에서 사용되는 공통 기능을 제공합니다.
- **주요 서비스**:
  - `NotificationComposerService`: 사이클 결과를 바탕으로 상세한 텔레그램 메시지 내용을 구성합니다.
  - `TelegramService`: 구성된 메시지를 실제 텔레그램 봇을 통해 발송합니다.
  - `FeeCalculatorService`: 거래/전송 수수료를 계산하여 예상 순수익률을 산출합니다.
  - `SlippageCalculatorService`: 실시간 호가창 데이터를 분석하여 정밀한 예상 슬리피지를 계산합니다.

## 데이터 흐름 (개선된 최종 플로우)

### **세션 기반 병렬 처리 플로우**

1. **세션 생성 및 자금 검증**

   - `SessionManagerService`가 실시간 가격 업데이트 또는 주기적 스캔을 통해 고프리미엄 기회를 발견합니다.
   - `SessionFundValidationService`가 세션 시작 전 자동으로 거래소 잔고를 검증합니다.
   - 자금이 충분한 경우 새로운 세션을 생성하고 고프리미엄 처리 상태로 전환합니다.

2. **세션 실행 및 우선순위 관리**

   - `SessionExecutorService`가 `SessionPriorityService`의 우선순위 계산에 따라 다음 처리할 세션을 선택합니다.
   - 각 세션은 독립적으로 실행되며, 시스템 리소스를 효율적으로 활용합니다.

3. **고프리미엄 처리 (HP 단계)**

   - **1단계 (시세 필터):** `ArbitrageFlowManagerService`는 실시간 시세로 프리미엄이 **최소 기준(예: 1.5%)**을 넘는 코인을 1차 선별합니다.
   - **2단계 (거래대금 필터):** 1차 선별된 코인들의 **24시간 거래대금**을 조회하여 유동성이 낮은 코인을 탈락시킵니다.
   - **3단계 (슬리피지 필터):** 최종 후보의 **호가창(Order Book)을 분석**하여, `SlippageCalculatorService`를 통해 예상 슬리피지를 계산하고 거래 실행 시의 실제 수익성을 최종 검증합니다.
   - `StrategyHighService`가 **지정가 주문**을 기본으로 거래를 시작하며, 미체결 시 **'호가 추적'** 로직으로 가격을 자동 정정하여 체결을 유도합니다.
   - `WithdrawalConstraintService`가 출금 수량을 코인별 제약 조건에 맞게 자동 조정합니다.
   - `DepositMonitorService`가 출금 후 입금 확인을 자동으로 모니터링합니다.

4. **저프리미엄 처리 (LP 단계)**

   - `LowPremiumProcessorService`는 '손익분기 프리미엄'을 충족하는 모든 코인을 대상으로 **HP 단계와 동일한 3단계 필터링**을 적용하여 가장 안전하고 효율적인 자금 회수 코인을 선택합니다.
   - `StrategyLowService`가 선택된 코인으로 '호가 추적' 로직을 사용해 안전하게 자금 회수 거래를 실행합니다.

5. **세션 완료 및 후처리**
   - `CycleCompletionService`가 최종 손익을 반영하여 `PortfolioLog`를 기록하고, `NotificationComposerService`를 통해 상세 결과 알림을 전송합니다.
   - 세션 상태가 완료 또는 실패로 업데이트되며, 시스템이 다음 기회를 탐색할 준비를 합니다.

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

## 환경 변수 설정

시스템 운영을 위해 다음 환경 변수들을 설정해야 합니다:

### **거래소 API 설정**

- `UPBIT_ACCESS_KEY`: 업비트 API 액세스 키
- `UPBIT_SECRET_KEY`: 업비트 API 시크릿 키
- `BINANCE_API_KEY`: 바이낸스 API 키
- `BINANCE_SECRET_KEY`: 바이낸스 시크릿 키

### **모드 설정**

- `UPBIT_MODE`: 업비트 모드 (`REAL` 또는 `SIMULATION`)
- `BINANCE_MODE`: 바이낸스 모드 (`REAL` 또는 `SIMULATION`)

### **세션 설정**

- `SESSION_INVESTMENT_AMOUNT_KRW`: 세션당 투자 금액 (KRW)

### **알림 설정**

- `TELEGRAM_BOT_TOKEN`: 텔레그램 봇 토큰
- `TELEGRAM_CHAT_ID`: 텔레그램 채팅 ID
- `NOTIFICATION_MODE`: 알림 모드 (`SUMMARY` 또는 `VERBOSE`)

### **데이터베이스 설정**

- `DB_HOST`: 데이터베이스 호스트
- `DB_PORT`: 데이터베이스 포트
- `DB_USERNAME`: 데이터베이스 사용자명
- `DB_PASSWORD`: 데이터베이스 비밀번호
- `DB_DATABASE`: 데이터베이스 이름
