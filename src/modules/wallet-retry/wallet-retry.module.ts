import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletRetryJob } from '@vector-games/game-core';
import { WalletRetryJobService } from './wallet-retry-job.service';
import { WalletRetryProcessorService } from './wallet-retry-processor.service';
import { WalletRetrySchedulerService } from './wallet-retry-scheduler.service';
import { SingleWalletFunctionsModule } from '../../routes/single-wallet-functions/single-wallet-functions.module';
import { BetModule } from '../bet/bet.module';
import { WalletAuditModule } from '../wallet-audit/wallet-audit.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WalletRetryJob]),
    forwardRef(() => SingleWalletFunctionsModule),
    BetModule,
    forwardRef(() => WalletAuditModule),
    RedisModule,
  ],
  providers: [
    WalletRetryJobService,
    WalletRetryProcessorService,
    WalletRetrySchedulerService,
  ],
  exports: [WalletRetryJobService],
})
export class WalletRetryModule {}

