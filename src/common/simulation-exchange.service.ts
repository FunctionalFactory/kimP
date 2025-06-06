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
} from './exchange.interface';

@Injectable()
export class SimulationExchangeService implements IExchange, OnModuleInit {
  private readonly logger = new Logger(SimulationExchangeService.name);

  // 잔고를 Map으로 관리하여 동적으로 변경
  private balances = new Map<string, Balance>();

  onModuleInit() {
    this.logger.log('SimulationExchangeService has been initialized.');
    // 초기 잔고 설정
    this.resetBalances();
  }

  // 테스트 등을 위해 잔고를 초기화하는 메소드
  public resetBalances(): void {
    this.balances.clear();
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

    const baseBalance = this.balances.get(baseCurrency) || {
      currency: baseCurrency,
      balance: 0,
      locked: 0,
      available: 0,
    };
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
    amount: number,
    tag?: string,
  ): Promise<any> {
    this.logger.log(
      `[SIMULATION] Withdrawing ${amount} ${symbol} to ${address}`,
    );

    const balance = this.balances.get(symbol.toUpperCase());
    if (!balance || balance.available < amount) {
      throw new Error(`Insufficient balance to withdraw ${amount} ${symbol}`);
    }

    // 출금 시 즉시 잔고에서 차감
    balance.balance -= amount;
    balance.available -= amount;
    this.balances.set(symbol.toUpperCase(), balance);
    this.logger.log(`[SIMULATION] Balance for ${symbol} reduced by ${amount}.`);

    // 입금 시뮬레이션을 위해 60초 후에 다시 잔고를 늘림
    setTimeout(() => {
      const targetBalance = this.balances.get(symbol.toUpperCase());
      if (targetBalance) {
        targetBalance.balance += amount;
        targetBalance.available += amount;
        this.balances.set(symbol.toUpperCase(), targetBalance);
        this.logger.log(
          `[SIMULATION] Deposit for ${amount} ${symbol} is confirmed.`,
        );
      }
    }, 60000); // 60초 지연

    return { id: `sim-withdraw-${Date.now()}`, amount };
  }

  // --- 이하 메소드들은 기존과 동일하게 유지 ---

  async getOrder(orderId: string, symbol?: string): Promise<Order> {
    throw new Error('Method not fully implemented for simulation.');
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
