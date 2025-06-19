// src/common/fee-calculator.service.ts
import { Injectable, Logger } from '@nestjs/common';

interface FeeInput {
  symbol: string;
  amount: number;
  upbitPrice: number;
  binancePrice: number;
  rate: number;
  tradeDirection: 'HIGH_PREMIUM_SELL_UPBIT' | 'LOW_PREMIUM_SELL_BINANCE';
}

interface FeeResult {
  grossProfit: number;
  totalFee: number;
  netProfit: number;
  netProfitPercent: number;

  binanceSpotBuyFeeKrw?: number;
  binanceSpotSellFeeKrw?: number;
  upbitBuyFeeKrw?: number;
  upbitSellFeeKrw?: number;
  binanceFuturesEntryFeeKrw?: number; // 선물 진입 수수료
  binanceFuturesExitFeeKrw?: number; // 선물 청산 수수료
  transferCoinToUpbitFeeKrw?: number; // 바이낸스 -> 업비트 코인 전송 수수료
  transferCoinToBinanceFeeKrw?: number; // 업비트 -> 바이낸스 코인 전송 수수료
  usdtTransferFeeKrw?: number; // USDT 전송 수수료 (주로 고프리미엄 시작 시)
}

@Injectable()
export class FeeCalculatorService {
  private readonly logger = new Logger(FeeCalculatorService.name);

  private readonly BINANCE_TRANSFER_FEE_TABLE: Record<string, number> = {
    xrp: 0.2,
    trx: 1,
    doge: 4,
    sol: 0.001,
    algo: 0.008,
    atom: 0.02,
    xlm: 0.01,
    ada: 0.8,
    dot: 0.8,
    avax: 0.008,
    hbar: 0.06,
    zil: 1,
    vet: 3,
    icx: 0.02,
    qtum: 0.05,
    neo: 0,
    bttc: 4000, // 바이낸스는 BTT가 아닌 BTTC 티커 사용
    mana: 6.76, // ERC20 기준
    grt: 20, // ERC20 기준
    lsk: 4.42,
    ardr: 2,
    iq: 50,
  };
  private readonly UPBIT_TRANSFER_FEE_TABLE: Record<string, number> = {
    xrp: 0.4,
    trx: 0.9,
    doge: 8,
    sol: 0.009,
    algo: 0.09,
    atom: 0.02,
    xlm: 0.005,
    ada: 0.45,
    dot: 0.075,
    avax: 0.01,
    hbar: 0.01,
    zil: 0.15,
    vet: 29.34,
    icx: 0.009,
    qtum: 0.009,
    neo: 0.03,
    btt: 0,
    mana: 4.28,
    grt: 7.3,
    lsk: 0.5,
    ardr: 2,
    a: 0.01,
    iq: 0,
  };

  private _applySlippage(
    price: number,
    amount: number,
    side: 'buy' | 'sell',
  ): number {
    // 매우 간단한 슬리피지 모델 예시: 거래량에 비례하여 0.05% ~ 0.15% 불리하게 조정
    const slippageRate = Math.min(0.0015, 0.0005 + (amount / 100000) * 0.0001);

    if (side === 'buy') {
      // 매수 시에는 가격이 약간 오름
      return price * (1 + slippageRate);
    } else {
      // 매도 시에는 가격이 약간 내림
      return price * (1 - slippageRate);
    }
  }

  private getBinanceTicker(symbol: string): string {
    const upperSymbol = symbol.toUpperCase();
    if (upperSymbol === 'BTT') {
      return 'BTTC';
    }
    return upperSymbol;
  }

  calculate(input: FeeInput): FeeResult {
    const { symbol, amount, upbitPrice, binancePrice, rate, tradeDirection } =
      input;

    // 슬리피지가 적용된 유효 가격 계산
    const effectiveUpbitPrice = this._applySlippage(
      upbitPrice,
      amount,
      tradeDirection === 'HIGH_PREMIUM_SELL_UPBIT' ? 'sell' : 'buy',
    );
    const effectiveBinancePrice = this._applySlippage(
      binancePrice,
      amount,
      tradeDirection === 'HIGH_PREMIUM_SELL_UPBIT' ? 'buy' : 'sell',
    );

    let grossProfit: number;
    let initialInvestmentKRW: number;
    let fees: Omit<
      FeeResult,
      'grossProfit' | 'totalFee' | 'netProfit' | 'netProfitPercent'
    > & { total: number };

    if (tradeDirection === 'HIGH_PREMIUM_SELL_UPBIT') {
      const globalBuyPriceKRW = effectiveBinancePrice * rate;
      grossProfit = (effectiveUpbitPrice - globalBuyPriceKRW) * amount;
      initialInvestmentKRW = globalBuyPriceKRW * amount;

      fees = this.estimateFeesForHighPremium(
        symbol,
        amount,
        binancePrice,
        upbitPrice,
        rate,
      );

      this.logger.log(
        `[수수료계산_고프] --- ${symbol.toUpperCase()} 고프리미엄 수수료 상세 내역 ---`,
      );
      this.logger.log(
        `  - 바이낸스 매수 수수료 (KRW): ${fees.binanceSpotBuyFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 업비트 매도 수수료 (KRW): ${fees.upbitSellFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 업비트로 전송 수수료 (KRW): ${fees.transferCoinToUpbitFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - USDT 전송 수수료 (KRW): ${fees.usdtTransferFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 선물 진입 수수료 (KRW): ${fees.binanceFuturesEntryFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 선물 청산 수수료 (KRW): ${fees.binanceFuturesExitFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(`  ----------------------------------------------------`);
    } else if (tradeDirection === 'LOW_PREMIUM_SELL_BINANCE') {
      const globalSellPriceKRW = effectiveBinancePrice * rate;
      grossProfit = (globalSellPriceKRW - effectiveUpbitPrice) * amount;
      initialInvestmentKRW = upbitPrice * amount;

      fees = this.estimateFeesForLowPremium(
        symbol,
        amount,
        binancePrice,
        upbitPrice,
        rate,
      );

      this.logger.log(
        `[수수료계산_저프] --- ${symbol.toUpperCase()} 저프리미엄 수수료 상세 내역 ---`,
      );
      this.logger.log(
        `  - 업비트 매수 수수료 (KRW): ${fees.upbitBuyFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 바이낸스 매도 수수료 (KRW): ${fees.binanceSpotSellFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 바이낸스로 전송 수수료 (KRW): ${fees.transferCoinToBinanceFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 선물 진입 수수료 (KRW): ${fees.binanceFuturesEntryFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(
        `  - 선물 청산 수수료 (KRW): ${fees.binanceFuturesExitFeeKrw?.toFixed(2)}`,
      );
      this.logger.log(`  ----------------------------------------------------`);
    } else {
      throw new Error('Invalid trade direction specified for fee calculation.');
    }

    const netProfit = grossProfit - fees.total;
    const netProfitPercent =
      initialInvestmentKRW !== 0 ? (netProfit / initialInvestmentKRW) * 100 : 0;

    const result = {
      grossProfit,
      totalFee: fees.total,
      netProfit,
      netProfitPercent,
      ...fees, // 계산된 모든 세부 수수료 항목을 반환 결과에 포함
    };

    return result;
  }

  // 고프리미엄 시나리오 (바이낸스 매수 -> 업비트 매도) 수수료 추정
  private estimateFeesForHighPremium(
    symbol: string,
    amount: number,
    binancePrice: number,
    upbitPrice: number,
    rate: number,
  ): {
    total: number;
    binanceSpotBuyFeeKrw: number;
    upbitSellFeeKrw: number;
    binanceFuturesEntryFeeKrw: number;
    binanceFuturesExitFeeKrw: number;
    transferCoinToUpbitFeeKrw: number;
    // usdtTransferFeeKrw: number;
  } {
    const spotFeeRate = 0.001;
    const futuresFeeRate = 0.0004;
    const upbitSellFeeRate = 0.00139;

    const binanceSpotBuyFeeKrw = amount * binancePrice * spotFeeRate * rate;
    const binanceFuturesEntryFeeKrw =
      amount * binancePrice * futuresFeeRate * rate;
    const binanceFuturesExitFeeKrw =
      amount * binancePrice * futuresFeeRate * rate;
    const upbitSellFeeKrw = amount * upbitPrice * upbitSellFeeRate;

    const binanceTicker = this.getBinanceTicker(symbol).toLowerCase();
    const transferUnit = this.BINANCE_TRANSFER_FEE_TABLE[binanceTicker];
    const transferCoinToUpbitFeeKrw =
      transferUnit !== undefined ? transferUnit * binancePrice * rate : 0;

    // const usdtTransferFeeKrw = 1 * rate;

    const total =
      binanceSpotBuyFeeKrw +
      upbitSellFeeKrw +
      binanceFuturesEntryFeeKrw +
      binanceFuturesExitFeeKrw +
      transferCoinToUpbitFeeKrw;
    // usdtTransferFeeKrw;

    const feeDetails = {
      total,
      binanceSpotBuyFeeKrw,
      upbitSellFeeKrw,
      binanceFuturesEntryFeeKrw,
      binanceFuturesExitFeeKrw,
      transferCoinToUpbitFeeKrw,
      // usdtTransferFeeKrw,
    };

    return feeDetails;
  }

  // 저프리미엄 (업비트 매수 -> 바이낸스 판매) 수수료
  private estimateFeesForLowPremium(
    symbol: string,
    amount: number,
    binancePrice: number,
    upbitPrice: number,
    rate: number,
  ): {
    total: number;
    upbitBuyFeeKrw: number;
    binanceSpotSellFeeKrw: number;
    binanceFuturesEntryFeeKrw: number;
    binanceFuturesExitFeeKrw: number;
    transferCoinToBinanceFeeKrw: number;
  } {
    const upbitBuyFeeRate = 0.0005;
    const binanceSellFeeRate = 0.001;
    const futuresFeeRate = 0.0004;

    const upbitBuyFeeKrw = amount * upbitPrice * upbitBuyFeeRate;
    const binanceSpotSellFeeKrw =
      amount * binancePrice * binanceSellFeeRate * rate;

    const binanceFuturesEntryFeeKrw =
      amount * binancePrice * futuresFeeRate * rate;
    const binanceFuturesExitFeeKrw =
      amount * binancePrice * futuresFeeRate * rate;

    const transferUnit = this.UPBIT_TRANSFER_FEE_TABLE[symbol.toLowerCase()];
    const transferCoinToBinanceFeeKrw =
      transferUnit !== undefined ? transferUnit * upbitPrice : 0; // 업비트 출금 시에는 업비트 가격으로 계산

    const total =
      upbitBuyFeeKrw +
      binanceSpotSellFeeKrw +
      binanceFuturesEntryFeeKrw +
      binanceFuturesExitFeeKrw +
      transferCoinToBinanceFeeKrw;

    const feeDetails = {
      total,
      upbitBuyFeeKrw,
      binanceSpotSellFeeKrw,
      binanceFuturesEntryFeeKrw,
      binanceFuturesExitFeeKrw,
      transferCoinToBinanceFeeKrw,
    };

    return feeDetails;
  }
}
