import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WsModule } from './ws/ws.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ArbitrageCycle } from './db/entities/arbitrage-cycle.entity';
import { PortfolioLog } from './db/entities/portfolio-log.entity';
import { MarketDataModule } from './marketdata/marketdata.module';
import { ArbitrageModule } from './arbitrage/arbitrage.module';
import { NotificationModule } from './notification/notification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: 3306,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      entities: [ArbitrageCycle, PortfolioLog],
      synchronize: true,
    }),
    WsModule,
    MarketDataModule,
    ArbitrageModule,
    NotificationModule,
  ],
})
export class AppModule {}
