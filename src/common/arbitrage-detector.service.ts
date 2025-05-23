// arbitrage-detector.service.ts
export class ArbitrageDetectorService {
  evaluateArbitrageTargets(
    watchedSymbols: { symbol: string }[],
    upbitPrices: Map<string, number>,
    binancePrices: Map<string, number>,
    rate: number,
    highThreshold: number,
    lowThreshold: number,
    handleHigh: (symbol: string) => void,
    handleLow: (symbol: string) => void,
    logger: any,
  ) {
    let maxSpread = -Infinity;
    let minSpread = Infinity;
    let maxSymbol = '';
    let minSymbol = '';

    for (const { symbol } of watchedSymbols) {
      const upbit = upbitPrices.get(symbol);
      const binance = binancePrices.get(symbol);
      if (!upbit || !binance) continue;

      const spread = ((upbit - binance * rate) / (binance * rate)) * 100;

      if (spread > maxSpread) {
        maxSpread = spread;
        maxSymbol = symbol;
      }

      if (spread < minSpread) {
        minSpread = spread;
        minSymbol = symbol;
      }
    }

    if (maxSymbol && maxSpread > highThreshold) {
      logger.warn(
        `[ARBITRAGE] 고프리미엄 감지: ${maxSymbol} (${maxSpread.toFixed(2)}%)`,
      );
      handleHigh(maxSymbol);
    }

    if (minSymbol && minSpread < lowThreshold) {
      logger.warn(
        `[ARBITRAGE] 저프리미엄 감지: ${minSymbol} (${minSpread.toFixed(2)}%)`,
      );
      handleLow(minSymbol);
    }
  }
}
