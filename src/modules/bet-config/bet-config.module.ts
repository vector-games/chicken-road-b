import { Module, Global } from '@nestjs/common';
import { BetModule } from '@vector-games/game-core';
import { GameModule } from '../games/game.module';
import { GameService } from '../games/game.service';

// Import GAME_VALIDATION_SERVICE from the package's compiled service
// Note: We need to use the same symbol that BetService uses
// Since it's not exported from index, we import from the dist file
import { GAME_VALIDATION_SERVICE } from '@vector-games/game-core/dist/services/bet/bet.service';

/**
 * Module that configures BetModule with GameService as the validation service
 * This enables automatic game validation when placing bets via BetService
 * 
 * IMPORTANT: Making this module global ensures GAME_VALIDATION_SERVICE is available
 * to BetService even when created in BetModule.forRoot() dynamic module context
 * 
 * BetService is automatically available through BetModule.forRoot() export
 */
@Global() // Make this module global so GAME_VALIDATION_SERVICE is available everywhere
@Module({
  imports: [
    GameModule, // Import GameModule to get GameService
    BetModule.forRoot(), // Initialize BetModule (exports BetService)
  ],
  providers: [
    {
      provide: GAME_VALIDATION_SERVICE,
      useExisting: GameService, // Use GameService as GameValidationService
    },
  ],
  exports: [BetModule, GAME_VALIDATION_SERVICE], // Export both so they're available
})
export class BetConfigModule {}
