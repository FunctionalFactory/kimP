// src/common/exchange.interface.ts

/**
 * 주문의 상태를 나타내는 타입
 * - open: 미체결
 * - filled: 전체 체결 완료
 * - partially_filled: 부분 체결
 * - canceled: 취소됨
 */
export type OrderStatus = 'open' | 'filled' | 'partially_filled' | 'canceled';

/**
 * 주문의 종류를 나타내는 타입
 * - limit: 지정가
 * - market: 시장가
 */
export type OrderType = 'limit' | 'market';

/**
 * 주문 방향을 나타내는 타입
 * - buy: 매수
 * - sell: 매도
 */
export type OrderSide = 'buy' | 'sell';

/**
 * 거래 수수료 정보를 담는 인터페이스
 */
export interface TradeFeeInfo {
  makerCommission: number; // 지정가 거래 수수료율 (e.g., 0.001 for 0.1%)
  takerCommission: number; // 시장가 거래 수수료율
}

/**
 * 출금 가능 정보를 담는 인터페이스
 */
export interface WithdrawalChance {
  currency: string;
  fee: number; // 출금 수수료
  minWithdrawal: number; // 최소 출금 수량
  // ... 필요하다면 일일 한도, 계정별 한도 등 추가 가능
}

/**
 * 개별 주문 정보를 담는 인터페이스
 */
export interface Order {
  id: string; // 거래소에서 발급한 주문 ID
  symbol: string; // 예: 'XRP/KRW'
  type: OrderType;
  side: OrderSide;
  price: number; // 주문 가격
  amount: number; // 주문 수량
  filledAmount: number; // 체결된 수량
  status: OrderStatus;
  timestamp: Date; // 주문 시간
  fee: {
    currency: string;
    cost: number;
  };
}

/**
 * 계좌의 자산 정보를 담는 인터페이스
 */
export interface Balance {
  currency: string; // 화폐 코드 (예: 'KRW', 'BTC')
  balance: number; // 총 보유 수량
  locked: number; // 주문 등으로 동결된 수량
  available: number; // 사용 가능한 수량
}

/**
 * 호가창의 한 레벨(가격대) 정보를 담는 인터페이스
 */
export interface OrderBookLevel {
  price: number; // 가격
  amount: number; // 수량
}

/**
 * 24시간 티커 정보를 담는 인터페이스
 */
export interface TickerInfo {
  symbol: string;
  quoteVolume: number; // 24시간 누적 거래대금 (Quote Asset 기준, KRW 또는 USDT)
}

/**
 * 실시간 호가창 정보를 담는 인터페이스
 */
export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[]; // 매수 주문 목록 (높은 가격 순)
  asks: OrderBookLevel[]; // 매도 주문 목록 (낮은 가격 순)
  timestamp: Date;
}

/**
 * 입출금 지갑 상태를 담는 인터페이스
 */
export interface WalletStatus {
  currency: string;
  canDeposit: boolean;
  canWithdraw: boolean;
  network?: string; // 네트워크 명 (예: 'Mainnet')
}

/**
 * 모든 거래소 서비스가 반드시 구현해야 하는 기능의 명세
 */
export interface IExchange {
  /**
   * 지정가 또는 시장가 주문을 생성합니다.
   * @param symbol - 'XRP'와 같이 거래소에서 사용하는 코인 심볼
   * @param type - 'limit' 또는 'market'
   * @param side - 'buy' 또는 'sell'
   * @param amount - 주문 수량
   * @param price - 주문 가격 (시장가 주문 시 null 또는 생략 가능)
   * @returns 생성된 주문의 초기 정보
   */
  createOrder(
    symbol: string,
    type: OrderType,
    side: OrderSide,
    amount: number,
    price?: number,
  ): Promise<Order>;

  /**
   * 특정 주문의 현재 상태를 조회합니다.
   * @param orderId - 조회할 주문의 ID
   * @param symbol - (선택적) 일부 거래소에서 필요
   * @returns 갱신된 주문 정보
   */
  getOrder(orderId: string, symbol?: string): Promise<Order>;

  /**
   * 사용자의 전체 계좌 잔고를 조회합니다.
   * @returns 자산 목록 배열
   */
  getBalances(): Promise<Balance[]>;

  /**
   * 실시간 호가창 정보를 조회합니다. (슬리피지 방지용)
   * @param symbol - 'XRP'와 같이 조회할 코인 심볼
   * @returns 호가창 정보
   */
  getOrderBook(symbol: string): Promise<OrderBook>;

  /**
   * 특정 코인의 입출금 지갑 상태를 조회합니다.
   * @param symbol - 'XRP'와 같이 조회할 코인 심볼
   * @returns 지갑 상태 정보
   */
  getWalletStatus(symbol: string): Promise<WalletStatus>;

  /**
   * 특정 코인의 입금 주소를 조회합니다.
   * @param symbol - 'XRP'와 같이 조회할 코인 심볼
   * @returns 입금 주소와 태그(필요시)
   */
  getDepositAddress(
    symbol: string,
  ): Promise<{ address: string; tag?: string; net_type?: string }>;

  /**
   * 특정 코인을 외부 주소로 출금합니다.
   * @param symbol - 'XRP'와 같이 출금할 코인 심볼
   * @param address - 출금할 주소
   * @param amount - 출금할 수량
   * @param net_type - (선택적) 리플, 이오스 등 네트워크 타입
   * @returns 출금 요청 결과 (거래소별 상이)
   */
  withdraw(
    symbol: string,
    address: string,
    amount: string,
    secondary_address?: string,
    net_type?: string,
  ): Promise<any>;

  /**
   * 특정 코인의 출금 제약 조건(수수료, 최소수량 등)을 조회합니다.
   * @param symbol - 'XRP'와 같이 조회할 코인 심볼
   * @returns 출금 가능 정보
   */
  getWithdrawalChance(symbol: string): Promise<WithdrawalChance>;

  /**
   * 특정 주문을 취소합니다.
   * @param orderId 취소할 주문의 ID
   * @param symbol (선택적) 일부 거래소에서 필요
   * @returns 취소 요청 결과
   */
  cancelOrder(orderId: string, symbol?: string): Promise<any>;

  /**
   * 특정 코인의 24시간 티커 정보를 조회합니다.
   * @param symbol 조회할 코인 심볼
   * @returns 티커 정보
   */
  getTickerInfo(symbol: string): Promise<TickerInfo>;

  /**
   * <<<< 신규 추가: 선물 주문 생성 >>>>
   * 선물(Futures) 주문을 생성합니다. (헷지용)
   * @param symbol - 'XRP'와 같이 거래소에서 사용하는 코인 심볼
   * @param side - 'BUY'(숏커버) 또는 'SELL'(숏 진입)
   * @param type - 'MARKET', 'LIMIT' 등
   * @param amount - 주문 수량
   * @param price - (선택적) 지정가 주문 시 가격
   * @returns 생성된 선물 주문의 정보
   */
  createFuturesOrder(
    symbol: string,
    side: OrderSide,
    type: OrderType,
    amount: number,
    price?: number,
  ): Promise<Order>;
}
