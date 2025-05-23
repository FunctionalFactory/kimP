// profit-calculator.service.ts
interface FeeInput {
  symbol: string;
  amount: number;
  upbitPrice: number;
  binancePrice: number;
  rate: number;
}

interface FeeResult {
  grossProfit: number;
  totalFee: number;
  netProfit: number;
  netProfitPercent: number;
}

export class ProfitCalculatorService {
  calculate(
    input: FeeInput,
    feeCalculatorService: { calculate(input: FeeInput): FeeResult },
  ): FeeResult {
    return feeCalculatorService.calculate(input);
  }
}
