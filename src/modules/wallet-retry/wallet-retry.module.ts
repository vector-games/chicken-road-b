import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletRetryJob, WalletRetryModule as CoreWalletRetryModule, WalletRetryService } from '@vector-games/game-core';
import { WalletRetryProcessorService } from './wallet-retry-processor.service';
import { WalletRetrySchedulerService } from './wallet-retry-scheduler.service';
import { WalletConfigModule } from '../wallet-config/wallet-config.module';
import { BetModule } from '../bet/bet.module';
import { WalletAuditModule } from '../wallet-audit/wallet-audit.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WalletRetryJob]),
    CoreWalletRetryModule, // Provides WalletRetryService from package
    WalletConfigModule, // Provides WalletService from package
    BetModule,
    forwardRef(() => WalletAuditModule),
    RedisModule,
  ],
  providers: [
    WalletRetryProcessorService,
    WalletRetrySchedulerService,
  ],
  exports: [CoreWalletRetryModule], // Export WalletRetryService from package
})
export class WalletRetryModule {}

