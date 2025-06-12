// src/common/simulation-exchange.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  IExchange,
  Order,
  OrderBook,
  OrderSide,
  OrderType,
  Balance,
  WalletStatus,
  WithdrawalChance,
} from './exchange.interface';

@Injectable()
export class SimulationExchangeService implements IExchange, OnModuleInit {
  private readonly logger = new Logger(SimulationExchangeService.name);

  // 잔고를 Map으로 관리하여 동적으로 변경
  private balances = new Map<string, Balance>();

  private simulatedOrders = new Map<string, Order>(); // 생성된 주문을 저장할 Map

  onModuleInit() {
    this.logger.log('SimulationExchangeService has been initialized.');
    // 초기 잔고 설정
    this.resetBalances();
  }

  // 테스트 등을 위해 잔고를 초기화하는 메소드
  public resetBalances(): void {
    this.balances.clear();
    this.simulatedOrders.clear(); // ⭐️ 잔고 리셋 시 주문 기록도 클리어
    this.balances.set('KRW', {
      currency: 'KRW',
      balance: 10000000,
      locked: 0,
      available: 10000000,
    });
    this.balances.set('XRP', {
      currency: 'XRP',
      balance: 100,
      locked: 0,
      available: 100,
    });
    this.balances.set('BTT', {
      currency: 'BTT',
      balance: 5000000,
      locked: 0,
      available: 5000000,
    });
  }

  async createOrder(
    symbol: string,
    type: OrderType,
    side: OrderSide,
    amount: number,
    price?: number,
  ): Promise<Order> {
    const orderPrice = price || 700; // 시장가일 경우 임의의 가격
    this.logger.log(
      `[SIMULATION] Creating ${side} ${type} order for ${amount} ${symbol} at ${orderPrice}`,
    );

    const baseCurrency = symbol.toUpperCase(); // 예: XRP
    const quoteCurrency = 'KRW'; // 예: KRW

    // 잔고가 없는 코인이면 동적으로 생성
    if (!this.balances.has(baseCurrency)) {
      this.balances.set(baseCurrency, {
        currency: baseCurrency,
        balance: 0,
        locked: 0,
        available: 0,
      });
      this.logger.log(
        `[SIMULATION] Dynamically initialized balance for ${baseCurrency}.`,
      );
    }

    const baseBalance = this.balances.get(baseCurrency)!;
    const quoteBalance = this.balances.get(quoteCurrency)!;

    // 잔고 확인 및 업데이트
    if (side === 'buy') {
      const requiredQuoteAmount = amount * orderPrice;
      if (quoteBalance.available < requiredQuoteAmount) {
        throw new Error(`Insufficient balance for ${quoteCurrency}`);
      }
      quoteBalance.balance -= requiredQuoteAmount;
      quoteBalance.available -= requiredQuoteAmount;
      baseBalance.balance += amount;
      baseBalance.available += amount;
    } else {
      // sell
      if (baseBalance.available < amount) {
        throw new Error(`Insufficient balance for ${baseCurrency}`);
      }
      baseBalance.balance -= amount;
      baseBalance.available -= amount;
      const receivedQuoteAmount = amount * orderPrice;
      quoteBalance.balance += receivedQuoteAmount;
      quoteBalance.available += receivedQuoteAmount;
    }

    this.balances.set(baseCurrency, baseBalance);
    this.balances.set(quoteCurrency, quoteBalance);
    this.logger.log(
      `[SIMULATION] Balances updated: ${baseCurrency}=${baseBalance.available}, ${quoteCurrency}=${quoteBalance.available}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const mockOrder: Order = {
      id: `sim-order-${Date.now()}`,
      symbol: `${symbol}/KRW`,
      type,
      side,
      price: orderPrice,
      amount,
      filledAmount: amount,
      status: 'filled',
      timestamp: new Date(),
      fee: { currency: 'KRW', cost: amount * orderPrice * 0.0005 },
    };

    this.logger.log(`[SIMULATION] Storing order ${mockOrder.id} in memory.`);
    this.simulatedOrders.set(mockOrder.id, mockOrder); // ⭐️ 생성된 주문을 Map에 저장

    this.logger.log(`[SIMULATION] Order ${mockOrder.id} has been filled.`);
    return mockOrder;
  }

  async getBalances(): Promise<Balance[]> {
    this.logger.log('[SIMULATION] Getting balances.');
    return Array.from(this.balances.values());
  }

  async withdraw(
    symbol: string,
    address: string,
    amount: string,
    secondary_address?: string,
    net_type?: string,
  ): Promise<any> {
    this.logger.log(
      `[SIMULATION] Withdrawing ${amount} ${symbol} to ${address}`,
    );
    return { id: `sim-withdraw-${Date.now()}`, amount };
  }

  // [구현] IExchange 인터페이스를 만족시키기 위해 추가
  async getWithdrawalChance(symbol: string): Promise<WithdrawalChance> {
    this.logger.log(`[SIMULATION] Getting withdrawal chance for ${symbol}.`);
    // 시뮬레이션을 위한 모의 데이터 반환
    const mockChances: { [key: string]: WithdrawalChance } = {
      XRP: { currency: 'XRP', fee: 1, minWithdrawal: 2 },
      BTC: { currency: 'BTC', fee: 0.0005, minWithdrawal: 0.001 },
    };
    return (
      mockChances[symbol.toUpperCase()] || {
        currency: symbol,
        fee: 0.1,
        minWithdrawal: 1,
      }
    );
  }

  // [구현] IExchange 인터페이스를 만족시키기 위해 추가 (getWithdrawalChance 호출)
  async getWithdrawalFee(
    symbol: string,
  ): Promise<{ currency: string; fee: number }> {
    const chance = await this.getWithdrawalChance(symbol);
    return { currency: chance.currency, fee: chance.fee };
  }

  // --- 이하 메소드들은 기존과 동일하게 유지 ---

  async getOrder(orderId: string, symbol?: string): Promise<Order> {
    this.logger.log(`[SIMULATION] Getting status for order ${orderId}`);
    const storedOrder = this.simulatedOrders.get(orderId);

    if (storedOrder) {
      this.logger.log(
        `[SIMULATION] Found stored order details for ${orderId}.`,
      );
      return storedOrder; // ⭐️ 저장된 주문 정보가 있으면 그대로 반환
    }

    // 혹시 모를 예외 상황에 대비한 폴백(Fallback) 로직
    this.logger.warn(
      `[SIMULATION] Order ${orderId} not found in memory. Returning a generic mock.`,
    );
    return {
      id: orderId,
      symbol: symbol ? `${symbol.toUpperCase()}/KRW` : 'SIM/KRW',
      type: 'limit',
      side: 'buy',
      price: 0,
      amount: 0,
      filledAmount: 0,
      status: 'filled',
      timestamp: new Date(),
      fee: { currency: 'KRW', cost: 0 },
    };
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    return {
      symbol: `${symbol}/KRW`,
      bids: [
        { price: 700.0, amount: 1000 },
        { price: 699.9, amount: 2000 },
      ],
      asks: [
        { price: 700.1, amount: 1500 },
        { price: 700.2, amount: 2500 },
      ],
      timestamp: new Date(),
    };
  }

  async getWalletStatus(symbol: string): Promise<WalletStatus> {
    return {
      currency: symbol,
      canDeposit: true,
      canWithdraw: true,
      network: 'Mainnet',
    };
  }

  async getDepositAddress(
    symbol: string,
  ): Promise<{ address: string; tag?: string }> {
    return { address: `sim-address-${symbol}`, tag: `sim-tag-${symbol}` };
  }
}
