import { Module } from '@nestjs/common';
import { SessionManagerService } from './session-manager.service';
import { SessionStateService } from './session-state.service';
import { SessionPriorityService } from './session-priority.service';
import { SessionExecutorService } from './session-executor.service';
import { ArbitrageModule } from '../arbitrage/arbitrage.module';
import { MarketDataModule } from '../marketdata/marketdata.module';
import { CommonModule } from '../common/common.module'; // ⭐️ 추가
import { SessionFundValidationService } from 'src/db/session-fund-validation.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionFundValidation } from 'src/db/entities/session-fund-validation.entity';

@Module({
  imports: [
    ArbitrageModule,
    MarketDataModule,
    CommonModule,
    TypeOrmModule.forFeature([SessionFundValidation]),
  ],
  providers: [
    SessionManagerService,
    SessionStateService,
    SessionPriorityService,
    SessionExecutorService,
    SessionFundValidationService,
  ],
  exports: [SessionManagerService],
})
export class SessionModule {}
