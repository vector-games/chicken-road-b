import { Module, Logger, OnModuleInit, Global } from '@nestjs/common';
import { WalletModule } from '@vector-games/game-core';
import { WALLET_API_ADAPTER } from '@vector-games/game-core/dist/services/wallet/wallet.service';
import { GameModule } from '../games/game.module';
import { GameService } from '../games/game.service';

/**
 * Module that configures WalletModule with GameService as the WalletApiAdapter
 * This enables automatic game payloads in wallet API calls
 * 
 * IMPORTANT: Making WALLET_API_ADAPTER global so WalletService can find it
 * even when created in WalletModule.forRoot() dynamic module context
 */
@Global() // Make this module global so WALLET_API_ADAPTER is available everywhere
@Module({
  imports: [
    GameModule, // Import GameModule to get GameService
    WalletModule.forRoot(), // Initialize WalletModule (WalletService will look for WALLET_API_ADAPTER globally)
  ],
  providers: [
    {
      provide: WALLET_API_ADAPTER,
      useExisting: GameService, // Use GameService as WalletApiAdapter
    },
  ],
  exports: [WalletModule, WALLET_API_ADAPTER], // Export both so they're available
})
export class WalletConfigModule implements OnModuleInit {
  private readonly logger = new Logger(WalletConfigModule.name);

  constructor(private readonly gameService: GameService) {}

  onModuleInit() {
    this.logger.log('[WalletConfigModule] WalletConfigModule initialized');
    this.logger.log(`[WalletConfigModule] GameService instance: ${this.gameService ? '✅ available' : '❌ NOT available'}`);
    this.logger.log(`[WalletConfigModule] GameService type: ${this.gameService?.constructor?.name || 'unknown'}`);
  }
}
