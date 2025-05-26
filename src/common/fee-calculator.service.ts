// src/common/fee-calculator.service.ts
import { Injectable } from '@nestjs/common';

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
  private readonly TRANSFER_FEE_TABLE_KRW: Record<string, number> = {
    xrp: 0.25,
    trx: 15,
    doge: 5,
    sol: 0.02,
    matic: 0.1,
    ltc: 0.001,
    algo: 0.01,
    atom: 0.01,
    eos: 0.01,
    xlm: 0.01,
    ada: 0.01,
    dot: 0.01,
    avax: 0.01,
    ftm: 0.01,
    hbar: 0.01,
    zil: 0.01,
    vet: 0.01,
    icx: 0.01,
    qtum: 0.01,
    neo: 0.01,
  };

  calculate(input: FeeInput): FeeResult {
    const { symbol, amount, upbitPrice, binancePrice, rate, tradeDirection } =
      input;

    let grossProfit: number;
    let initialInvestmentKRW: number;
    let fees: Omit<
      FeeResult,
      'grossProfit' | 'totalFee' | 'netProfit' | 'netProfitPercent'
    > & { total: number };

    if (tradeDirection === 'HIGH_PREMIUM_SELL_UPBIT') {
      const globalBuyPriceKRW = binancePrice * rate;
      grossProfit = (upbitPrice - globalBuyPriceKRW) * amount;
      initialInvestmentKRW = globalBuyPriceKRW * amount;

      fees = this.estimateFeesForHighPremium(
        symbol,
        amount,
        binancePrice,
        upbitPrice,
        rate,
      );
    } else if (tradeDirection === 'LOW_PREMIUM_SELL_BINANCE') {
      const globalSellPriceKRW = binancePrice * rate;
      grossProfit = (globalSellPriceKRW - upbitPrice) * amount;
      initialInvestmentKRW = upbitPrice * amount;

      fees = this.estimateFeesForLowPremium(
        symbol,
        amount,
        binancePrice,
        upbitPrice,
        rate,
      );
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
    usdtTransferFeeKrw: number;
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

    const transferUnit = this.TRANSFER_FEE_TABLE_KRW[symbol.toLowerCase()];
    const transferCoinToUpbitFeeKrw =
      transferUnit !== undefined ? transferUnit * upbitPrice : 0;

    const usdtTransferFeeKrw = 1 * rate;

    const total =
      binanceSpotBuyFeeKrw +
      upbitSellFeeKrw +
      binanceFuturesEntryFeeKrw +
      binanceFuturesExitFeeKrw +
      transferCoinToUpbitFeeKrw +
      usdtTransferFeeKrw;

    const feeDetails = {
      total,
      binanceSpotBuyFeeKrw,
      upbitSellFeeKrw,
      binanceFuturesEntryFeeKrw,
      binanceFuturesExitFeeKrw,
      transferCoinToUpbitFeeKrw,
      usdtTransferFeeKrw,
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

    const transferUnit = this.TRANSFER_FEE_TABLE_KRW[symbol.toLowerCase()];
    const transferCoinToBinanceFeeKrw =
      transferUnit !== undefined ? transferUnit * binancePrice * rate : 0;

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
