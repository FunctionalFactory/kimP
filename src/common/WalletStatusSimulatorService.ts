// src/common/wallet-status-simulator.service.ts
import { Injectable, Logger } from '@nestjs/common';

type WalletStatus = 'ACTIVE' | 'DEPOSIT_DISABLED' | 'WITHDRAW_DISABLED';

@Injectable()
export class WalletStatusSimulatorService {
  private readonly logger = new Logger(WalletStatusSimulatorService.name);
  private walletStates = new Map<
    string,
    { upbit: WalletStatus; binance: WalletStatus }
  >();
  private symbols = ['xrp', 'trx', 'doge', 'sol', 'matic']; // 예시 심볼

  constructor() {
    // 초기 상태는 모두 ACTIVE로 설정
    this.symbols.forEach((s) =>
      this.walletStates.set(s, { upbit: 'ACTIVE', binance: 'ACTIVE' }),
    );

    // 30분에 한 번씩 임의의 코인 지갑 상태를 변경하는 시뮬레이션
    setInterval(() => {
      const randomSymbol =
        this.symbols[Math.floor(Math.random() * this.symbols.length)];
      const states: WalletStatus[] = [
        'ACTIVE',
        'DEPOSIT_DISABLED',
        'WITHDRAW_DISABLED',
      ];
      const randomState = states[Math.floor(Math.random() * states.length)];
      const targetExchange = Math.random() > 0.5 ? 'upbit' : 'binance';

      const currentState = this.walletStates.get(randomSymbol)!;
      currentState[targetExchange] = randomState;
      this.logger.warn(
        `[SIMULATION] Wallet status for ${randomSymbol.toUpperCase()} on ${targetExchange} changed to ${randomState}`,
      );
    }, 1800000); // 30분
  }

  getWalletStatus(symbol: string): {
    upbit: WalletStatus;
    binance: WalletStatus;
  } {
    return (
      this.walletStates.get(symbol) ?? { upbit: 'ACTIVE', binance: 'ACTIVE' }
    );
  }
}
